const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');

const mysql = require('mysql2/promise'); // promise 기반 라이브러리 사용

// 커넥션 풀 생성
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'burntowin.cafe24app.com', // 서버: 10.0.0.1, 로컬: burntowin.cafe24app.com 
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
app.use(express.json());

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
    res.render('index', { matches: rows, currentPage: 'index' });
  } catch (err) {
    console.error('[/] 에러:', err.message);
    res.status(500).send('서버 오류가 발생했습니다.');
  }
});

// 경기 기록 입력 페이지 보여주기
app.get('/new', async (req, res) => {
  try {
    const membersPromise = pool.query('SELECT name FROM member ORDER BY `order` ASC, name ASC');
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
            const weightedDiff = stats.matches > 0 ? Math.round(((stats.deuceWins - stats.adWins) / stats.matches) * 100) : 0;

            return { ...stats, winRate, deuceRate, deuceWinRate, adRate, adWinRate, weightedDiff };
        });
        
        scores.sort((a, b) => b.matches - a.matches);

        res.render('my-score', { scores, courts, currentPage: 'my-score' });

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

                        // 같은편일 때
                        if ((isBaseOnTeam1 && isCompareOnTeam1) || (isBaseOnTeam2 && isCompareOnTeam2)) {
                            stats.sameTeamMatches++;
                            const result = isBaseOnTeam1 ? match.team1_result : match.team2_result;
                            if (result === '승') stats.sameTeamWins++;
                            else if (result === '패') stats.sameTeamLosses++;
                            else if (result === '무') stats.sameTeamDraws++;
                        } 
                        // 상대편일 때 (기준 플레이어 입장에서의 승/무/패)
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
        const finalChemistryData = chemistryData.map(stats => {
            const sameTeamWinRate = safeRate(stats.sameTeamWins, stats.sameTeamMatches);
            const opponentWinRate = safeRate(stats.opponentWins, stats.opponentMatches);
            // [추가] 승률 차이 계산
            const winRateDiff = sameTeamWinRate - opponentWinRate;

            return {
                ...stats,
                sameTeamWinRate,
                opponentWinRate,
                winRateDiff // 템플릿으로 전달할 객체에 추가
            };
        }).sort((a, b) => b.sameTeamMatches - a.sameTeamMatches);
        
        res.render('chemistry', {
            members,
            courts,
            chemistryData: finalChemistryData,
            selectedPlayer: player,
            currentPage: 'chemistry'
        });

    } catch (err) {
        console.error('[/chemistry] 에러:', err.message);
        res.status(500).send('서버 오류가 발생했습니다.');
    }
});

// 케미 스코어
app.get('/chemistry-score', async (req, res) => {
    try {
        // 1. 필요한 모든 데이터를 병렬로 가져옵니다.
        const matchesPromise = pool.query(`
            SELECT * FROM matchrecord 
            WHERE team1_result IS NOT NULL 
              AND team1_ad IS NOT NULL AND team1_ad != ''
              AND team2_ad IS NOT NULL AND team2_ad != ''
        `);
        const courtsPromise = pool.query("SELECT DISTINCT court AS name FROM matchrecord WHERE court IS NOT NULL AND court != '' ORDER BY name ASC");
        // ✨ 정회원(order=0) 명단을 가져오는 쿼리 추가
        const membersPromise = pool.query("SELECT name FROM member WHERE `order` = 0");

        const [[allMatches], [courts], [regularMembers]] = await Promise.all([matchesPromise, courtsPromise, membersPromise]);
        
        // 정회원 이름을 Set으로 만들어 빠른 조회를 가능하게 함
        const regularMemberSet = new Set(regularMembers.map(m => m.name));

        // 2. 필터 처리
        let { period = '6m', types = '남복,여복,혼복,혼복(남3),혼복(여3),혼복(남vs여)', courts: courtFilter } = req.query;
        let filteredMatches = applyPeriodFilter(allMatches, period);
        if (types) {
            filteredMatches = filteredMatches.filter(m => types.split(',').includes(m.type));
        }
        if (courtFilter) {
            filteredMatches = filteredMatches.filter(m => courtFilter.split(',').includes(m.court));
        }

        // 3. 페어별 통계 계산
        const pairStats = {};
        filteredMatches.forEach(match => {
            const team1Players = [match.team1_deuce, match.team1_ad];
            const team2Players = [match.team2_deuce, match.team2_ad];

            const processPair = (players, result) => {
                // ✨ 페어의 모든 멤버가 정회원인지 확인
                const isRegularPair = players.every(p => regularMemberSet.has(p));
                if (!isRegularPair) return; // 정회원 페어가 아니면 건너뜀

                const pairKey = players.sort().join('/');
                if (!pairStats[pairKey]) {
                    pairStats[pairKey] = { matches: 0, wins: 0, losses: 0 };
                }
                pairStats[pairKey].matches++;
                if (result === '승') pairStats[pairKey].wins++;
                else if (result === '패') pairStats[pairKey].losses++;
            };

            processPair(team1Players, match.team1_result);
            processPair(team2Players, match.team2_result);
        });

        // 4. 최종 데이터 가공 및 렌더링
        const pairData = Object.keys(pairStats).map(key => {
            const stats = pairStats[key];
            const winRate = stats.matches > 0 ? Math.round((stats.wins / stats.matches) * 100) : 0;
            return { pair: key, matches: stats.matches, wins: stats.wins, losses: stats.losses, winRate };
        });
        
        res.render('chemistry-score', { pairData, courts, currentPage: 'chemistry-score' });

    } catch (err) {
        console.error('[/chemistry-score] 에러:', err.message);
        res.status(500).send('서버 오류가 발생했습니다.');
    }
});

// ✨ API: 특정 페어의 경기 기록 조회 (추가)
app.get('/api/matches/pair', async (req, res) => {
    try {
        // 1. 요청으로부터 필터 조건과 페어 정보 가져오기
        let { pair, period, types, courts: courtFilter } = req.query;
        if (!pair) {
            return res.status(400).json({ message: '페어 정보가 필요합니다.' });
        }
        const [player1, player2] = pair.split('/');

        // 2. 전체 경기 기록 가져오기
        const [allMatches] = await pool.query('SELECT * FROM matchrecord WHERE team1_result IS NOT NULL');
        
        // 3. 기간, 분류, 코트 필터 적용
        let filteredMatches = applyPeriodFilter(allMatches, period);
        if (types) {
            filteredMatches = filteredMatches.filter(m => types.split(',').includes(m.type));
        }
        if (courtFilter) {
            filteredMatches = filteredMatches.filter(m => courtFilter.split(',').includes(m.court));
        }

        // 4. 해당 페어가 '같은 팀'으로 뛴 경기만 필터링
        const pairMatches = filteredMatches.filter(match => {
            const team1 = [match.team1_deuce, match.team1_ad];
            const team2 = [match.team2_deuce, match.team2_ad];
            const isTeam1 = team1.includes(player1) && team1.includes(player2);
            const isTeam2 = team2.includes(player1) && team2.includes(player2);
            return isTeam1 || isTeam2;
        });

        // 5. 최신순으로 정렬
        pairMatches.sort((a, b) => new Date(b.date) - new Date(a.date) || b.id - a.id);
        
        // 6. 결과 전송
        res.json(pairMatches);

    } catch (err) {
        console.error('[/api/matches/pair] 에러:', err.message);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// 출석부 페이지
app.get('/attendance', async (req, res) => {
    try {
        // 1. 년/월 파라미터 가져오기 (없으면 현재 날짜 기준)
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;

        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDayOfMonth = new Date(year, month, 0).getDate();
        const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDayOfMonth).padStart(2, '0')}`;

        // 2. DB에서 데이터 가져오기 (정회원 목록, 해당 월의 경기 기록)
        const membersPromise = pool.query('SELECT name FROM member WHERE etc = "" ORDER BY name ASC');
        const matchesPromise = pool.query(
            `SELECT date, team1_deuce, team1_ad, team2_deuce, team2_ad FROM matchrecord WHERE date BETWEEN ? AND ?`,
            [startDate, endDate]
        );

        const [[members], [matches]] = await Promise.all([membersPromise, matchesPromise]);

        // 3. 출석 데이터 가공
        const attendanceData = members.map(member => {
            const attendedDates = new Set();
            matches.forEach(match => {
                const players = [match.team1_deuce, match.team1_ad, match.team2_deuce, match.team2_ad];
                if (players.includes(member.name)) {
                    attendedDates.add(new Date(match.date).getDate()); // 날짜(일)만 Set에 추가하여 중복 방지
                }
            });
            return {
                name: member.name,
                attendanceCount: attendedDates.size,
                // Set을 배열로 변환하고, 오름차순 정렬 후, 쉼표로 구분된 문자열로 만듭니다.
                attendedDays: Array.from(attendedDates).sort((a, b) => a - b).join(', ')
            };
        });

        // 4. EJS 템플릿 렌더링
        res.render('attendance', {
            year,
            month,
            attendanceData,
            currentPage: 'attendance'
        });

    } catch (err) {
        console.error('[/attendance] 에러:', err.message);
        res.status(500).send('서버 오류가 발생했습니다.');
    }
});

// API: 특정 멤버의 전체 출석 기록 조회
app.get('/api/member-attendance/:name', async (req, res) => {
    try {
        const memberName = req.params.name;

        // 1. 해당 멤버가 참여한 모든 경기 기록을 날짜 오름차순으로 가져온다.
        const sql = `
            SELECT date
            FROM matchrecord
            WHERE team1_deuce = ? OR team1_ad = ? OR team2_deuce = ? OR team2_ad = ?
            ORDER BY date DESC
        `;
        const [matches] = await pool.query(sql, [memberName, memberName, memberName, memberName]);

        if (matches.length === 0) {
            return res.json([]); // 출석 기록이 없으면 빈 배열 반환
        }

        // 2. 월별로 데이터 가공 (년-월을 key로 사용)
        const monthlyStats = {}; // ex: { "2025-07": { days: Set(1, 2, 3) } }

        matches.forEach(match => {
            const date = new Date(match.date);
            const year = date.getFullYear();
            const month = date.getMonth() + 1;
            const day = date.getDate();
            const yearMonthKey = `${year}-${String(month).padStart(2, '0')}`;

            if (!monthlyStats[yearMonthKey]) {
                monthlyStats[yearMonthKey] = {
                    days: new Set()
                };
            }
            monthlyStats[yearMonthKey].days.add(day);
        });

        // 3. 최종 결과 배열로 변환
        const result = Object.keys(monthlyStats).map(key => {
            const [year, month] = key.split('-');
            const daysSet = monthlyStats[key].days;
            return {
                yearMonth: `${year}년 ${parseInt(month, 10)}월`,
                attendanceCount: daysSet.size,
                attendedDays: Array.from(daysSet).sort((a, b) => a - b).join(', ')
            };
        });
        
        // 년-월 최신순으로 정렬
        result.sort((a, b) => {
            const dateA = new Date(a.yearMonth.replace('년 ', '-').replace('월', ''));
            const dateB = new Date(b.yearMonth.replace('년 ', '-').replace('월', ''));
            return dateB - dateA;
        });


        res.json(result);

    } catch (err) {
        console.error(`[/api/member-attendance/:name] 에러:`, err.message);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

app.get('/exchange-match', (req, res) => {
    res.render('exchange-match'); // views/exchange.ejs 를 렌더링
});

app.get('/api/exchange-match', async (req, res) => {
    try {
    const [rows] = await pool.query(`
              SELECT id, CAST(CONCAT(match_date, ' ', opponent_team_name) AS CHAR) AS label
                FROM ex_match_master
               ORDER BY match_date DESC
    `);
    
    res.json(rows);
    } catch (err) {
        console.error('[/api/exchange-match] 에러:', err.message);
        res.status(500).json({ error: '데이터를 불러오는 중 오류가 발생했습니다.' });
    }
});

app.get('/api/exchange-match/:id', async (req, res) => {
  const matchId = req.params.id;
  try {
    const [rows] = await pool.query(`
      SELECT
        court_num,
        match_round,
        deuce_player,
        ad_player,
        match_type,
        my_team_score,
        op_team_score,
        match_result,
        videographer
      FROM ex_match_detail
      WHERE match_master_id = ?
      ORDER BY court_num, match_round
    `, [matchId]);
    res.json(rows);
  } catch (err) {
    console.error(`[/api/exchange-match/${matchId}] 에러:`, err.message);
    res.status(500).json({ error: '데이터 조회 실패' });
  }
});

// GET 상세
app.get('/api/exchange-match/detail', async (req, res) => {
  const { masterId, courtNum, matchRound } = req.query;
  const sql = `
    SELECT * FROM ex_match_detail 
    WHERE match_master_id = ? AND court_num = ? AND match_round = ?
  `;
  const [rows] = await pool.query(sql, [masterId, courtNum, matchRound]);
  res.json(rows[0] || {});
});

// PUT 수정
app.put('/api/exchange-match/detail', async (req, res) => {
    console.log('PUT 요청:', req.body);
    const { masterId, courtNum, matchRound, deuce_player, ad_player, my_team_score, op_team_score } = req.body;

    const sql = `
        UPDATE ex_match_detail
        SET deuce_player = ?, ad_player = ?, my_team_score = ?, op_team_score = ?
        WHERE match_master_id = ? AND court_num = ? AND match_round = ?
    `;

    console.log('쿼리 실행:', sql);
    console.log('파라미터:', [
        deuce_player, ad_player, my_team_score, op_team_score,
        masterId, courtNum, matchRound
    ]);

    await pool.query(sql, [
        deuce_player, ad_player, my_team_score, op_team_score,
        masterId, courtNum, matchRound
    ]);

  res.json({ success: true });
});

const PORT = 8001;
app.listen(PORT, () => {
    console.log(`http://localhost:${PORT} 에서 서버 실행 중`);
});
