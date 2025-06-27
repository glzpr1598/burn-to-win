const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');

const mysql = require('mysql2/promise'); // promise 기반 라이브러리 사용

// 커넥션 풀 생성
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost', // 서버: 10.0.0.1, 로컬: localhost 
  charset: 'utf8', // 서버: utf8mb4, 로컬: utf8
  user: process.env.DB_USER || 'burntowin',
  password: process.env.DB_PASSWORD || 'qnfRhc1@',
  database: process.env.DB_NAME || 'burntowin',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // MySQL의 DATETIME 타입을 Javascript Date 객체로 자동 변환하지 않도록 설정
  // 날짜 필터링 시 문자열로 비교하는 것이 더 간단하고 안전할 수 있습니다.
  dateStrings: true 
});

const app = express();
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// --- 유틸리티 함수 ---
// 쿼리 파라미터에 따른 기간 필터링 로직 (중복을 줄이기 위해 함수로 추출)
const applyPeriodFilter = (matches, period) => {
    if (!period || period === 'all') {
        return matches;
    }

    const today = new Date();
    let startDate = new Date();
    let endDate;

    if (period === '1m') startDate.setMonth(today.getMonth() - 1);
    else if (period === '3m') startDate.setMonth(today.getMonth() - 3);
    else if (period === '6m') startDate.setMonth(today.getMonth() - 6);
    else if (period === '1y') startDate.setFullYear(today.getFullYear() - 1);
    else if (period === '2024') {
        startDate = new Date('2024-01-01');
        endDate = new Date('2024-12-31T23:59:59');
    } else if (period === '2025') {
        startDate = new Date('2025-01-01');
        endDate = new Date('2025-12-31T23:59:59');
    } else {
        return matches; // 유효하지 않은 기간 값은 무시
    }
    
    // JS Date 객체의 시간 부분을 0으로 설정하여 날짜만 비교
    startDate.setHours(0, 0, 0, 0);

    return matches.filter(m => {
        const matchDate = new Date(m.date);
        matchDate.setHours(0, 0, 0, 0); // 경기 날짜의 시간 정보 제거
        
        if (endDate) {
            return matchDate >= startDate && matchDate <= endDate;
        }
        return matchDate >= startDate && matchDate <= today;
    });
};


// --- 라우트 핸들러 ---

// 홈화면 (경기 기록 목록)
app.get('/', async (req, res) => {
  try {
    const sql = 'SELECT * FROM matchrecord ORDER BY date DESC, id DESC';
    const [rows] = await pool.query(sql);
    res.render('index', { matches: rows });
  } catch (err) {
    console.error('[/] 에러:', err.message);
    res.status(500).send('서버 오류가 발생했습니다.');
  }
});

// 경기 기록 입력 페이지 보여주기
app.get('/new', async (req, res) => {
  try {
    const membersPromise = pool.query('SELECT name FROM member ORDER BY id ASC');
    const courtsPromise = pool.query("SELECT DISTINCT court AS name FROM matchrecord WHERE court IS NOT NULL AND court != '' ORDER BY name ASC");

    // 두 쿼리를 병렬로 실행
    const [[members], [courts]] = await Promise.all([membersPromise, courtsPromise]);
    
    res.render('new', { members: members, courts: courts });
  } catch (err) {
    console.error('[/new] 에러:', err.message);
    res.status(500).send('데이터 조회 중 오류가 발생했습니다.');
  }
});

// 경기 기록 수정 페이지 보여주기
app.get('/edit/:id', async (req, res) => {
    const matchId = req.params.id;
    try {
        const matchPromise = pool.query('SELECT * FROM matchrecord WHERE id = ?', [matchId]);
        const membersPromise = pool.query('SELECT name FROM member ORDER BY id ASC');
        const courtsPromise = pool.query("SELECT DISTINCT court AS name FROM matchrecord WHERE court IS NOT NULL AND court != '' ORDER BY name ASC");

        const [[matchRows], [members], [courts]] = await Promise.all([matchPromise, membersPromise, courtsPromise]);
        
        const match = matchRows[0]; // id로 조회했으므로 결과는 하나 또는 없음
        if (!match) {
            return res.status(404).send('해당 기록을 찾을 수 없습니다.');
        }

        res.render('edit', { match: match, members: members, courts: courts });

    } catch (err) {
        console.error(`[/edit/${matchId}] 에러:`, err.message);
        res.status(500).send('데이터 조회 중 오류가 발생했습니다.');
    }
});


// 공통 로직: 경기 타입 계산 함수
const calculateMatchType = async (players) => {
    const playerNames = players.filter(name => name);
    const uniquePlayerNames = [...new Set(playerNames)];
    
    if (uniquePlayerNames.length === 0) return '기타';

    const placeholders = uniquePlayerNames.map(() => '?').join(',');
    const sql = `SELECT name, gender FROM member WHERE name IN (${placeholders})`;
    
    const [rows] = await pool.query(sql, uniquePlayerNames);
    const genderMap = rows.reduce((acc, row) => {
        acc[row.name] = row.gender;
        return acc;
    }, {});

    const g1d = genderMap[players[0]];
    const g1a = genderMap[players[1]] || '';
    const g2d = genderMap[players[2]];
    const g2a = genderMap[players[3]] || '';
    
    const genders = [g1d, g1a, g2d, g2a].filter(g => g);
    const maleCount = genders.filter(g => g === '남').length;
    const femaleCount = genders.filter(g => g === '여').length;
    const totalPlayers = genders.length;

    if (totalPlayers === 2) {
        if (maleCount === 2) return '남단';
        if (femaleCount === 2) return '여단';
        return '혼단(남vs여)';
    }
    if (totalPlayers === 4) {
        if (maleCount === 4) return '남복';
        if (femaleCount === 4) return '여복';
        if (maleCount === 3) return '혼복(남3)';
        if (femaleCount === 3) return '혼복(여3)';
        if (maleCount === 2) {
            const isTeam1AllMale = [g1d, g1a].every(g => g === '남');
            const isTeam2AllFemale = [g2d, g2a].every(g => g === '여');
            if (isTeam1AllMale && isTeam2AllFemale) return '혼복(남vs여)';
            
            const isTeam1AllFemale = [g1d, g1a].every(g => g === '여');
            const isTeam2AllMale = [g2d, g2a].every(g => g === '남');
            if (isTeam1AllFemale && isTeam2AllMale) return '혼복(남vs여)';
            
            return '혼복';
        }
    }
    return '기타';
};

// 경기 기록 업데이트 처리
app.post('/update/:id', async (req, res) => {
    const matchId = req.params.id;
    const {
        date, court,
        team1_deuce, team1_ad,
        team2_deuce, team2_ad,
        team1_score, team2_score,
        video, etc
    } = req.body;

    try {
        let team1_result, team2_result;
        if (Number(team1_score) > Number(team2_score)) {
            team1_result = '승';
            team2_result = '패';
        } else if (Number(team1_score) < Number(team2_score)) {
            team1_result = '패';
            team2_result = '승';
        } else {
            team1_result = '무';
            team2_result = '무';
        }

        const type = await calculateMatchType([team1_deuce, team1_ad, team2_deuce, team2_ad]);
        
        const sql = `
            UPDATE matchrecord SET
                date = ?, court = ?,
                team1_deuce = ?, team1_ad = ?,
                team2_deuce = ?, team2_ad = ?,
                team1_score = ?, team2_score = ?,
                video = ?, etc = ?,
                team1_result = ?, team2_result = ?,
                type = ?
            WHERE id = ?
        `;
        const params = [
            date, court,
            team1_deuce, team1_ad || null,
            team2_deuce, team2_ad || null,
            team1_score, team2_score,
            video, etc,
            team1_result, team2_result, type,
            matchId
        ];
        
        await pool.query(sql, params);
        res.redirect('/');

    } catch (err) {
        console.error(`[/update/${matchId}] 에러:`, err.message);
        res.status(500).send('데이터 업데이트 중 오류가 발생했습니다.');
    }
});

// 새로운 경기 기록 저장하기
app.post('/matches', async (req, res) => {
    const {
        date, court,
        team1_deuce, team1_ad,
        team2_deuce, team2_ad,
        team1_score, team2_score,
        video, etc
    } = req.body;

    try {
        let team1_result, team2_result;
        if (Number(team1_score) > Number(team2_score)) {
            team1_result = '승';
            team2_result = '패';
        } else if (Number(team1_score) < Number(team2_score)) {
            team1_result = '패';
            team2_result = '승';
        } else {
            team1_result = '무';
            team2_result = '무';
        }

        const type = await calculateMatchType([team1_deuce, team1_ad, team2_deuce, team2_ad]);
        
        const sql = `
            INSERT INTO matchrecord 
            (date, court, team1_deuce, team1_ad, team2_deuce, team2_ad, team1_score, team2_score, video, etc, team1_result, team2_result, type) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const params = [
            date, court,
            team1_deuce, team1_ad || null,
            team2_deuce, team2_ad || null,
            team1_score, team2_score,
            video, etc,
            team1_result, team2_result, type
        ];
        
        await pool.query(sql, params);
        res.redirect('/');

    } catch (err) {
        console.error('[/matches] 에러:', err.message);
        res.status(500).send('데이터 저장 중 오류가 발생했습니다.');
    }
});


// 개인 스코어 페이지
app.get('/my-score', async (req, res) => {
    try {
        const membersPromise = pool.query('SELECT name FROM member WHERE etc = "" ORDER BY name ASC');
        const matchesPromise = pool.query('SELECT * FROM matchrecord WHERE team1_result IS NOT NULL');
        const courtsPromise = pool.query("SELECT DISTINCT court AS name FROM matchrecord WHERE court IS NOT NULL AND court != '' ORDER BY name ASC");

        const [[members], [allMatches], [courts]] = await Promise.all([membersPromise, matchesPromise, courtsPromise]);

        let { period = '6m', types = '남단,여단,남복,여복,혼복', courts: courtFilter } = req.query;

        // 기간 필터 적용
        let filteredMatches = applyPeriodFilter(allMatches, period);
        
        // 분류 필터
        if (types) {
            const typeArr = types.split(',');
            filteredMatches = filteredMatches.filter(m => typeArr.includes(m.type));
        }
        // 코트 필터
        if (courtFilter) {
            const courtArr = courtFilter.split(',');
            filteredMatches = filteredMatches.filter(m => courtArr.includes(m.court));
        }
        
        const scores = members.map(member => {
            // [수정] 무승부 및 포지션별 패배, 무승부 기록을 위한 필드 추가
            const stats = {
                name: member.name, matches: 0, wins: 0, losses: 0, draws: 0,
                deuceMatches: 0, deuceWins: 0, deuceLosses: 0, deuceDraws: 0,
                adMatches: 0, adWins: 0, adLosses: 0, adDraws: 0,
            };

            filteredMatches.forEach(match => {
                let isOnTeam1 = false, isOnTeam2 = false, position = '';
                if (match.team1_deuce === member.name) { isOnTeam1 = true; position = 'deuce'; }
                else if (match.team1_ad === member.name) { isOnTeam1 = true; position = 'ad'; }
                else if (match.team2_deuce === member.name) { isOnTeam2 = true; position = 'deuce'; }
                else if (match.team2_ad === member.name) { isOnTeam2 = true; position = 'ad'; }

                if (isOnTeam1 || isOnTeam2) {
                    stats.matches++;
                    const result = isOnTeam1 ? match.team1_result : match.team2_result;
                    
                    // [수정] 승/패/무 결과에 따라 해당 기록 증가
                    if (result === '승') stats.wins++;
                    else if (result === '패') stats.losses++;
                    else if (result === '무') stats.draws++;
                    
                    if (position === 'deuce') {
                        stats.deuceMatches++;
                        if (result === '승') stats.deuceWins++;
                        else if (result === '패') stats.deuceLosses++;
                        else if (result === '무') stats.deuceDraws++;
                    } else if (position === 'ad') {
                        stats.adMatches++;
                        if (result === '승') stats.adWins++;
                        else if (result === '패') stats.adLosses++;
                        else if (result === '무') stats.adDraws++;
                    }
                }
            });

            const safeRate = (numerator, denominator) => denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
            
            const winRate = safeRate(stats.wins, stats.matches);
            const deuceRate = safeRate(stats.deuceMatches, stats.matches);
            const deuceWinRate = safeRate(stats.deuceWins, stats.deuceMatches);
            const adRate = safeRate(stats.adMatches, stats.matches);
            const adWinRate = safeRate(stats.adWins, stats.adMatches);
            const winRateDiff = deuceWinRate - adWinRate;

            return { ...stats, winRate, deuceRate, deuceWinRate, adRate, adWinRate, winRateDiff };
        });
        
        scores.sort((a, b) => b.matches - a.matches);

        res.render('my-score', { scores, courts });

    } catch (err) {
        console.error('[/my-score] 에러:', err.message);
        res.status(500).send('서버 오류가 발생했습니다.');
    }
});

// 상대와 케미 페이지
app.get('/chemistry', async (req, res) => {
    try {
        const membersPromise = pool.query('SELECT name FROM member WHERE etc = "" ORDER BY name ASC');
        const matchesPromise = pool.query('SELECT * FROM matchrecord WHERE team1_result IS NOT NULL');
        const courtsPromise = pool.query("SELECT DISTINCT court AS name FROM matchrecord WHERE court IS NOT NULL AND court != '' ORDER BY name ASC");

        const [[members], [allMatches], [courts]] = await Promise.all([membersPromise, matchesPromise, courtsPromise]);

        let { player, period = '6m', types = '남단,여단,남복,여복,혼복', courts: courtFilter } = req.query;
        if (!player && members.length > 0) {
            player = members[0].name;
        }

        let filteredMatches = applyPeriodFilter(allMatches, period);
        if (types) {
            const typeArr = types.split(',');
            filteredMatches = filteredMatches.filter(m => typeArr.includes(m.type));
        }
        if (courtFilter) {
            const courtArr = courtFilter.split(',');
            filteredMatches = filteredMatches.filter(m => courtArr.includes(m.court));
        }
        
        let chemistryData = [];
        if (player) {
            chemistryData = members
                .filter(member => member.name !== player)
                .map(compareMember => {
                    // [수정] 승/무/패를 모두 기록하도록 필드 확장
                    const stats = { 
                        name: compareMember.name, 
                        sameTeamMatches: 0, sameTeamWins: 0, sameTeamDraws: 0, sameTeamLosses: 0,
                        opponentMatches: 0, opponentWins: 0, opponentDraws: 0, opponentLosses: 0 
                    };

                    filteredMatches.forEach(match => {
                        const team1 = [match.team1_deuce, match.team1_ad].filter(p => p);
                        const team2 = [match.team2_deuce, match.team2_ad].filter(p => p);
                        const isBaseOnTeam1 = team1.includes(player);
                        const isBaseOnTeam2 = team2.includes(player);
                        const isCompareOnTeam1 = team1.includes(compareMember.name);
                        const isCompareOnTeam2 = team2.includes(compareMember.name);

                        // 같은 편일 때
                        if ((isBaseOnTeam1 && isCompareOnTeam1) || (isBaseOnTeam2 && isCompareOnTeam2)) {
                            stats.sameTeamMatches++;
                            const result = isBaseOnTeam1 ? match.team1_result : match.team2_result;
                            if (result === '승') stats.sameTeamWins++;
                            else if (result === '패') stats.sameTeamLosses++;
                            else if (result === '무') stats.sameTeamDraws++;
                        } 
                        // 상대 편일 때 (기준 플레이어 입장에서의 승/무/패)
                        else if ((isBaseOnTeam1 && isCompareOnTeam2) || (isBaseOnTeam2 && isCompareOnTeam1)) {
                            stats.opponentMatches++;
                            const result = isBaseOnTeam1 ? match.team1_result : match.team2_result;
                             if (result === '승') stats.opponentWins++;
                            else if (result === '패') stats.opponentLosses++;
                            else if (result === '무') stats.opponentDraws++;
                        }
                    });
                    return stats;
                });
        }

        const safeRate = (numerator, denominator) => denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
        const finalChemistryData = chemistryData.map(stats => ({
            ...stats,
            sameTeamWinRate: safeRate(stats.sameTeamWins, stats.sameTeamMatches),
            opponentWinRate: safeRate(stats.opponentWins, stats.opponentMatches)
        })).sort((a, b) => b.sameTeamMatches - a.sameTeamMatches);
        
        res.render('chemistry', {
            members,
            courts,
            chemistryData: finalChemistryData,
            selectedPlayer: player,
        });

    } catch (err) {
        console.error('[/chemistry] 에러:', err.message);
        res.status(500).send('서버 오류가 발생했습니다.');
    }
});


const PORT = 8001;
app.listen(PORT, () => {
    console.log(`http://localhost:${PORT} 에서 서버 실행 중`);
});
