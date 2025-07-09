const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise'); // promise 기반 라이브러리 사용
const bcrypt = require('bcrypt');
const saltRounds = 10;
const session = require('express-session'); // express-session 추가

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
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json()); // JSON 요청 본문을 파싱하기 위해 추가
app.use(express.static(path.join(__dirname, 'public')));

// 세션 미들웨어 설정
app.use(session({
    secret: 'your_secret_key', // 실제 환경에서는 더 복잡하고 안전한 키를 사용해야 합니다.
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // HTTPS를 사용하지 않는 경우 false로 설정
}));

// 관리자 인증 미들웨어
const isAuthenticated = (req, res, next) => {
    if (req.session.isAdmin) {
        next();
    } else {
        res.redirect('/admin');
    }
};

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

function formatDateTime(datetimeString) {
    const date = new Date(datetimeString);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

// --- 라우트 핸들러 ---

// 홈화면 -> 일정 페이지로 리디렉션
app.get('/', (req, res) => {
    res.redirect('/schedule');
});

// 경기 기록
app.get('/match-record', async (req, res) => {
    try {
        const sql = 'SELECT * FROM matchrecord ORDER BY date DESC, court ASC, id DESC';
        const [rows] = await pool.query(sql);
        res.render('match-record', { matches: rows, currentPage: 'match-record' });
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
        res.redirect('/match-record');

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

        // ✨ 요청 타입을 확인하여 다르게 응답하는 로직
        if (req.is('json')) {
            // 'Content-Type'이 'application/json'인 경우 (fetch 요청)
            res.json({ success: true, message: '경기가 성공적으로 기록되었습니다.' });
        } else {
            // 그 외의 경우 (일반 form 제출)
            res.redirect('/match-record');
        }

    } catch (err) {
        console.error('[/matches] 에러:', err.message);

        if (req.is('json')) {
            res.status(500).json({ success: false, message: '데이터 저장 중 오류가 발생했습니다.' });
        } else {
            res.status(500).send('데이터 저장 중 오류가 발생했습니다.');
        }
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
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;

        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const lastDayOfMonth = new Date(year, month, 0).getDate();
        const endDate = `${year}-${String(month).padStart(2, '0')}-${String(lastDayOfMonth).padStart(2, '0')}`;

        // 1. 정회원 목록과 해당 월의 '일정 참석' 기록을 가져옵니다.
        const membersPromise = pool.query('SELECT name FROM member WHERE `order` = 0 ORDER BY name ASC');
        const attendanceRecordsPromise = pool.query(
            `SELECT sa.member_name, s.schedule_date
             FROM schedule_attendees sa
             JOIN schedules s ON sa.schedule_id = s.id
             WHERE s.schedule_date BETWEEN ? AND ?`,
            [startDate, endDate]
        );

        const [[members], [records]] = await Promise.all([membersPromise, attendanceRecordsPromise]);

        // 2. 회원별로 출석일 데이터를 가공합니다.
        const attendanceByMember = new Map();
        records.forEach(record => {
            const day = new Date(record.schedule_date).getDate();
            if (!attendanceByMember.has(record.member_name)) {
                attendanceByMember.set(record.member_name, new Set());
            }
            attendanceByMember.get(record.member_name).add(day);
        });

        // 3. 최종 데이터를 생성합니다.
        const attendanceData = members.map(member => {
            const attendedDates = attendanceByMember.get(member.name) || new Set();
            return {
                name: member.name,
                attendanceCount: attendedDates.size,
                attendedDays: Array.from(attendedDates).sort((a, b) => a - b).join(', ')
            };
        });

        // 4. EJS 템플릿을 렌더링합니다.
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

        // ✨ 특정 회원의 모든 일정 참석 기록을 날짜 기준으로 가져오도록 쿼리 변경
        const sql = `
            SELECT s.schedule_date
            FROM schedule_attendees sa
            JOIN schedules s ON sa.schedule_id = s.id
            WHERE sa.member_name = ?
            ORDER BY s.schedule_date DESC
        `;
        const [records] = await pool.query(sql, [memberName]);

        if (records.length === 0) {
            return res.json([]);
        }

        // 월별로 데이터 가공 (기존 로직과 동일)
        const monthlyStats = {};
        records.forEach(record => {
            const date = new Date(record.schedule_date);
            const year = date.getFullYear();
            const month = date.getMonth() + 1;
            const day = date.getDate();
            const yearMonthKey = `${year}-${String(month).padStart(2, '0')}`;

            if (!monthlyStats[yearMonthKey]) {
                monthlyStats[yearMonthKey] = { days: new Set() };
            }
            monthlyStats[yearMonthKey].days.add(day);
        });

        const result = Object.keys(monthlyStats).map(key => {
            const [year, month] = key.split('-');
            const daysSet = monthlyStats[key].days;
            return {
                yearMonth: `${year}년 ${parseInt(month, 10)}월`,
                attendanceCount: daysSet.size,
                attendedDays: Array.from(daysSet).sort((a, b) => a - b).join(', ')
            };
        });

        // 년-월 최신순 정렬 (기존 로직과 동일)
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

// 일정 페이지
app.get('/schedule', async (req, res) => {
    try {
        const year = parseInt(req.query.year) || new Date().getFullYear();
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;

        const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const endDate = new Date(year, month, 0).toLocaleDateString('en-CA');

        const membersPromise = pool.query('SELECT name FROM member WHERE etc = "" ORDER BY name ASC');
        const schedulesPromise = pool.query(
            `SELECT * FROM schedules WHERE schedule_date BETWEEN ? AND ? ORDER BY schedule_date ASC, start_time ASC, location ASC`,
            [startDate, endDate]
        );

        const [[members], [schedules]] = await Promise.all([membersPromise, schedulesPromise]);

        if (schedules.length > 0) {
            const scheduleIds = schedules.map(s => s.id);

            // 각 일정의 참석자와 댓글을 병렬로 가져옵니다.
            const attendeesPromise = pool.query(`SELECT schedule_id, member_name FROM schedule_attendees WHERE schedule_id IN (?)`, [scheduleIds]);
            const commentsPromise = pool.query(`SELECT * FROM schedule_comments WHERE schedule_id IN (?) ORDER BY created_at ASC`, [scheduleIds]);
            const [[attendees], [comments]] = await Promise.all([attendeesPromise, commentsPromise]);

            const attendeesMap = new Map();
            attendees.forEach(att => {
                const list = attendeesMap.get(att.schedule_id) || [];
                list.push(att.member_name);
                attendeesMap.set(att.schedule_id, list);
            });

            const commentsMap = new Map();
            comments.forEach(comment => {
                const list = commentsMap.get(comment.schedule_id) || [];

                // 날짜 포맷 변경 (YYYY-MM-DD HH:mm)
                comment.created_at = formatDateTime(comment.created_at);

                list.push(comment);
                commentsMap.set(comment.schedule_id, list);
            });

            const scheduleData = schedules.map(schedule => ({
                ...schedule,
                attendees: attendeesMap.get(schedule.id) || [],
                comments: commentsMap.get(schedule.id) || []
            }));

            res.render('schedule', { year, month, members, schedules: scheduleData, currentPage: 'schedule' });

        } else {
            res.render('schedule', { year, month, members, schedules: [], currentPage: 'schedule' });
        }

    } catch (err) {
        console.error('[/schedule] 에러:', err.message);
        res.status(500).send('서버 오류가 발생했습니다.');
    }
});

// API: 일정 참석
app.post('/api/schedule/:id/attend', async (req, res) => {
    const scheduleId = req.params.id;
    const { memberName } = req.body;
    if (!memberName) {
        return res.status(400).json({ success: false, message: '사용자 이름이 필요합니다.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // ✨ 트랜잭션 내에서 현재 참석자 수와 최대 인원 수를 가져옵니다. (FOR UPDATE를 사용하여 비관적 잠금)
        const [scheduleRows] = await connection.query('SELECT maximum FROM schedules WHERE id = ? FOR UPDATE', [scheduleId]);
        const [attendeeRows] = await connection.query('SELECT COUNT(*) as count FROM schedule_attendees WHERE schedule_id = ?', [scheduleId]);
        
        if (scheduleRows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: '일정을 찾을 수 없습니다.' });
        }

        const maximumAttendees = scheduleRows[0].maximum;
        const currentAttendees = attendeeRows[0].count;

        // ✨ 최대 인원 수 체크
        if (currentAttendees >= maximumAttendees) {
            await connection.rollback();
            return res.status(400).json({ success: false, message: '이미 마감된 일정입니다.' });
        }

        // 1. 참석자 명단에 추가
        const attendSql = 'INSERT INTO schedule_attendees (schedule_id, member_name) VALUES (?, ?)';
        await connection.query(attendSql, [scheduleId, memberName]);

        // 2. 로그 기록
        const logSql = 'INSERT INTO schedule_attendance_log (schedule_id, member_name, action) VALUES (?, ?, ?)';
        await connection.query(logSql, [scheduleId, memberName, 'attend']);

        await connection.commit();
        res.json({ success: true, message: '참석 처리되었습니다.' });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error(`[/api/schedule/${scheduleId}/attend] 에러:`, err.message);
        // 중복 참석 시 발생하는 에러 처리
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: '이미 참석한 일정입니다.' });
        }
        res.status(500).json({ success: false, message: '참석 처리에 실패했습니다.' });
    } finally {
        if (connection) connection.release();
    }
});

// API: 일정 참석 취소
app.post('/api/schedule/:id/cancel', async (req, res) => {
    const scheduleId = req.params.id;
    const { memberName } = req.body;
    if (!memberName) {
        return res.status(400).json({ success: false, message: '사용자 이름이 필요합니다.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1. 참석자 명단에서 삭제
        const cancelSql = 'DELETE FROM schedule_attendees WHERE schedule_id = ? AND member_name = ?';
        const [result] = await connection.query(cancelSql, [scheduleId, memberName]);

        // 삭제가 성공했을 때만 로그 기록
        if (result.affectedRows > 0) {
            // 2. 로그 기록
            const logSql = 'INSERT INTO schedule_attendance_log (schedule_id, member_name, action) VALUES (?, ?, ?)';
            await connection.query(logSql, [scheduleId, memberName, 'cancel']);

            await connection.commit();
            res.json({ success: true, message: '참석이 취소되었습니다.' });
        } else {
            // 삭제할 데이터가 없으면 롤백하고 에러 메시지 전송
            await connection.rollback();
            res.status(404).json({ success: false, message: '취소할 참석 정보를 찾을 수 없습니다.' });
        }

    } catch (err) {
        if (connection) await connection.rollback();

        console.error(`[/api/schedule/${scheduleId}/cancel] 에러:`, err.message);
        res.status(500).json({ success: false, message: '참석 취소에 실패했습니다.' });
    } finally {
        if (connection) connection.release();
    }
});

// API: 댓글 생성
app.post('/api/comments', async (req, res) => {
    const { schedule_id, member_name, comment } = req.body;
    if (!schedule_id || !member_name || !comment) {
        return res.status(400).json({ success: false, message: '모든 필드를 입력해야 합니다.' });
    }
    try {
        const sql = 'INSERT INTO schedule_comments (schedule_id, member_name, comment) VALUES (?, ?, ?)';
        const [result] = await pool.query(sql, [schedule_id, member_name, comment]);
        const [rows] = await pool.query('SELECT * FROM schedule_comments WHERE id = ?', [result.insertId]);
        const newComment = rows[0];
        // 날짜 포맷 변경
        newComment.created_at = new Date(newComment.created_at).toLocaleString('ko-KR', {
            year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
        }).replace(/\. /g, '.');

        res.status(201).json({ success: true, comment: newComment });
    } catch (err) {
        console.error('[/api/comments] 에러:', err.message);
        res.status(500).json({ success: false, message: '댓글 작성에 실패했습니다.' });
    }
});

// API: 댓글 삭제
app.delete('/api/comments/:id', async (req, res) => {
    const commentId = req.params.id;
    // 실제 운영 환경에서는 요청을 보낸 사용자와 댓글 작성자가 일치하는지 한번 더 확인하는 로직이 필요합니다.
    try {
        await pool.query('DELETE FROM schedule_comments WHERE id = ?', [commentId]);
        res.json({ success: true, message: '댓글이 삭제되었습니다.' });
    } catch (err) {
        console.error(`[/api/comments/${commentId}] 에러:`, err.message);
        res.status(500).json({ success: false, message: '댓글 삭제에 실패했습니다.' });
    }
});

// API: 사용자 로그인 (선택 및 비밀번호 확인)
app.post('/api/user/login', async (req, res) => {
    const { name, password } = req.body;
    if (!name || !password) {
        return res.status(400).json({ success: false, message: '이름과 비밀번호를 모두 입력하세요.' });
    }
    try {
        const [rows] = await pool.query('SELECT password FROM member WHERE name = ?', [name]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: '존재하지 않는 사용자입니다.' });
        }

        const hashedPassword = rows[0].password;
        const match = await bcrypt.compare(password, hashedPassword);

        if (match) {
            res.json({ success: true, message: '로그인 성공' });
        } else {
            res.status(401).json({ success: false, message: '비밀번호가 일치하지 않습니다.' });
        }
    } catch (err) {
        console.error('[/api/user/login] 에러:', err.message);
        res.status(500).json({ success: false, message: '로그인 처리 중 오류 발생' });
    }
});

// API: 비밀번호 변경
app.post('/api/user/change-password', async (req, res) => {
    const { name, currentPassword, newPassword } = req.body;
    if (!name || !currentPassword || !newPassword) {
        return res.status(400).json({ success: false, message: '모든 필드를 입력하세요.' });
    }
    try {
        const [rows] = await pool.query('SELECT password FROM member WHERE name = ?', [name]);
        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: '사용자를 찾을 수 없습니다.' });
        }

        const hashedPassword = rows[0].password;
        const match = await bcrypt.compare(currentPassword, hashedPassword);

        if (!match) {
            return res.status(401).json({ success: false, message: '현재 비밀번호가 일치하지 않습니다.' });
        }

        const newHashedPassword = await bcrypt.hash(newPassword, saltRounds);
        await pool.query('UPDATE member SET password = ? WHERE name = ?', [newHashedPassword, name]);

        res.json({ success: true, message: '비밀번호가 성공적으로 변경되었습니다.' });
    } catch (err) {
        console.error('[/api/user/change-password] 에러:', err.message);
        res.status(500).json({ success: false, message: '비밀번호 변경 중 오류 발생' });
    }
});

// API: 일정 정산 상태 토글
app.post('/api/schedule/:id/toggle-calculation', async (req, res) => {
    const scheduleId = req.params.id;
    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 1. 현재 상태를 조회합니다.
        const [rows] = await connection.query('SELECT calculated FROM schedules WHERE id = ?', [scheduleId]);

        if (rows.length === 0) {
            await connection.rollback();
            return res.status(404).json({ success: false, message: '해당 일정을 찾을 수 없습니다.' });
        }

        // 2. 상태를 토글합니다. ('Y' -> 'N', 'N' -> 'Y')
        const currentStatus = rows[0].calculated;
        const newStatus = currentStatus === 'Y' ? 'N' : 'Y';

        // 3. 새로운 상태로 업데이트합니다.
        const updateSql = 'UPDATE schedules SET calculated = ? WHERE id = ?';
        await connection.query(updateSql, [newStatus, scheduleId]);

        await connection.commit();

        // 4. 성공 응답과 함께 새로운 상태를 클라이언트에 전달합니다.
        res.json({
            success: true,
            message: `정산 상태가 '${newStatus === 'Y' ? '완료' : '미완료'}'로 변경되었습니다.`,
            newStatus: newStatus
        });

    } catch (err) {
        if (connection) await connection.rollback();
        console.error(`[/api/schedule/${scheduleId}/toggle-calculation] 에러:`, err.message);
        res.status(500).json({ success: false, message: '정산 상태 변경 중 오류가 발생했습니다.' });
    } finally {
        if (connection) connection.release();
    }
});

// --- 관리자 페이지 라우트 ---
app.get('/admin', (req, res) => {
    if (req.session.isAdmin) {
        res.redirect('/admin/dashboard');
    } else {
        res.render('admin-login', { message: req.query.message });
    }
});

app.post('/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === '9999') { // 비밀번호 9999로 설정
        req.session.isAdmin = true;
        res.redirect('/admin/dashboard');
    } else {
        res.redirect('/admin?message=Invalid Password');
    }
});

app.get('/admin/dashboard', isAuthenticated, (req, res) => {
    res.render('admin', { currentPage: 'admin' });
});

app.get('/admin/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('로그아웃 에러:', err);
            return res.status(500).send('로그아웃 중 오류가 발생했습니다.');
        }
        res.redirect('/admin');
    });
});

// 경기 기록 삭제
app.post('/admin/delete-match', isAuthenticated, async (req, res) => {
    const { matchId } = req.body;
    try {
        const [result] = await pool.query('DELETE FROM matchrecord WHERE id = ?', [matchId]);
        if (result.affectedRows > 0) {
            res.json({ success: true, message: `경기 기록 (ID: ${matchId})이 삭제되었습니다.` });
        } else {
            res.status(404).json({ success: false, message: `경기 기록 (ID: ${matchId})을 찾을 수 없습니다.` });
        }
    } catch (err) {
        console.error('경기 기록 삭제 에러:', err.message);
        res.status(500).json({ success: false, message: '경기 기록 삭제 중 오류가 발생했습니다.' });
    }
});

// 일정 등록
app.post('/admin/add-schedule', isAuthenticated, async (req, res) => {
    const { schedule_date, start_time, end_time, location, notes, booker, price, maximum } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO schedules (schedule_date, start_time, end_time, location, notes, booker, price, maximum) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [schedule_date, start_time, end_time, location, notes, booker || null, price || null, maximum || 6]
        );
        res.json({ success: true, message: `일정 (ID: ${result.insertId})이 성공적으로 등록되었습니다.` });
    } catch (err) {
        console.error('일정 등록 에러:', err.message);
        res.status(500).json({ success: false, message: '일정 등록 중 오류가 발생했습니다.' });
    }
});

// 일정 수정
app.post('/admin/update-schedule', isAuthenticated, async (req, res) => {
    const { id, schedule_date, start_time, end_time, location, notes, booker, price, calculated, maximum } = req.body;
    try {
        const [result] = await pool.query(
            'UPDATE schedules SET schedule_date = ?, start_time = ?, end_time = ?, location = ?, notes = ?, booker = ?, price = ?, calculated = ?, maximum = ? WHERE id = ?',
            [schedule_date, start_time, end_time, location, notes, booker || null, price || null, calculated, maximum || 6, id]
        );
        if (result.affectedRows > 0) {
            res.json({ success: true, message: `일정 (ID: ${id})이 성공적으로 수정되었습니다.` });
        } else {
            res.status(404).json({ success: false, message: `일정 (ID: ${id})을 찾을 수 없습니다.` });
        }
    } catch (err) {
        console.error('일정 수정 에러:', err.message);
        res.status(500).json({ success: false, message: '일정 수정 중 오류가 발생했습니다.' });
    }
});

// 일정 삭제
app.post('/admin/delete-schedule', isAuthenticated, async (req, res) => {
    const { scheduleId } = req.body;
    try {
        const [result] = await pool.query('DELETE FROM schedules WHERE id = ?', [scheduleId]);
        if (result.affectedRows > 0) {
            res.json({ success: true, message: `일정 (ID: ${scheduleId})이 삭제되었습니다.` });
        } else {
            res.status(404).json({ success: false, message: `일정 (ID: ${scheduleId})을 찾을 수 없습니다.` });
        }
    } catch (err) {
        console.error('일정 삭제 에러:', err.message);
        res.status(500).json({ success: false, message: '일정 삭제 중 오류가 발생했습니다.' });
    }
});

app.post('/admin/delete-schedule', isAuthenticated, async (req, res) => {
    const { scheduleId } = req.body;
    try {
        const [result] = await pool.query('DELETE FROM schedules WHERE id = ?', [scheduleId]);
        if (result.affectedRows > 0) {
            res.json({ success: true, message: `일정 (ID: ${scheduleId})이 삭제되었습니다.` });
        } else {
            res.status(404).json({ success: false, message: `일정 (ID: ${scheduleId})을 찾을 수 없습니다.` });
        }
    } catch (err) {
        console.error('일정 삭제 에러:', err.message);
        res.status(500).json({ success: false, message: '일정 삭제 중 오류가 발생했습니다.' });
    }
});

// 멤버 등록
app.post('/admin/add-member', isAuthenticated, async (req, res) => {
    const { name, gender, etc, order } = req.body;
    try {
        // 기본 비밀번호 '0000'을 해싱하여 저장
        const hashedPassword = await bcrypt.hash('0000', saltRounds);
        const [result] = await pool.query(
            'INSERT INTO member (name, gender, etc, `order`, password) VALUES (?, ?, ?, ?, ?)',
            [name, gender, etc || '', order || 0, hashedPassword]
        );
        res.json({ success: true, message: `멤버 ${name}이(가) 성공적으로 등록되었습니다.` });
    } catch (err) {
        console.error('멤버 등록 에러:', err.message);
        res.status(500).json({ success: false, message: '멤버 등록 중 오류가 발생했습니다.' });
    }
});

// 멤버 수정
app.post('/admin/update-member', isAuthenticated, async (req, res) => {
    const { originalName, name, gender, etc, order } = req.body;
    try {
        const [result] = await pool.query(
            'UPDATE member SET name = ?, gender = ?, etc = ?, `order` = ? WHERE name = ?',
            [name, gender, etc || '', order || 0, originalName]
        );
        if (result.affectedRows > 0) {
            res.json({ success: true, message: `멤버 ${originalName}이(가) ${name}으로 성공적으로 수정되었습니다.` });
        } else {
            res.status(404).json({ success: false, message: `멤버 ${originalName}을(를) 찾을 수 없습니다.` });
        }
    } catch (err) {
        console.error('멤버 수정 에러:', err.message);
        res.status(500).json({ success: false, message: '멤버 수정 중 오류가 발생했습니다.' });
    }
});

// 멤버 삭제
app.post('/admin/delete-member', isAuthenticated, async (req, res) => {
    const { name } = req.body;
    try {
        const [result] = await pool.query('DELETE FROM member WHERE name = ?', [name]);
        if (result.affectedRows > 0) {
            res.json({ success: true, message: `멤버 ${name}이(가) 삭제되었습니다.` });
        } else {
            res.status(404).json({ success: false, message: `멤버 ${name}을(를) 찾을 수 없습니다.` });
        }
    } catch (err) {
        console.error('멤버 삭제 에러:', err.message);
        res.status(500).json({ success: false, message: '멤버 삭제 중 오류가 발생했습니다.' });
    }
});

// 비밀번호 초기화
app.post('/admin/reset-password', isAuthenticated, async (req, res) => {
    const { name } = req.body;
    try {
        const hashedPassword = await bcrypt.hash('0000', saltRounds);
        const [result] = await pool.query('UPDATE member SET password = ? WHERE name = ?', [hashedPassword, name]);
        if (result.affectedRows > 0) {
            res.json({ success: true, message: `멤버 ${name}의 비밀번호가 0000으로 초기화되었습니다.` });
        } else {
            res.status(404).json({ success: false, message: `멤버 ${name}을(를) 찾을 수 없습니다.` });
        }
    } catch (err) {
        console.error('비밀번호 초기화 에러:', err.message);
        res.status(500).json({ success: false, message: '비밀번호 초기화 중 오류가 발생했습니다.' });
    }
});

app.post('/admin/reset-password', isAuthenticated, async (req, res) => {
    const { name } = req.body;
    try {
        const hashedPassword = await bcrypt.hash('0000', saltRounds);
        const [result] = await pool.query('UPDATE member SET password = ? WHERE name = ?', [hashedPassword, name]);
        if (result.affectedRows > 0) {
            res.json({ success: true, message: `멤버 ${name}의 비밀번호가 0000으로 초기화되었습니다.` });
        } else {
            res.status(404).json({ success: false, message: `멤버 ${name}을(를) 찾을 수 없습니다.` });
        }
    } catch (err) {
        console.error('비밀번호 초기화 에러:', err.message);
        res.status(500).json({ success: false, message: '비밀번호 초기화 중 오류가 발생했습니다.' });
    }
});

// API: 모든 일정 가져오기
app.get('/api/admin/schedules', isAuthenticated, async (req, res) => {
    try {
        const [schedules] = await pool.query('SELECT id, schedule_date, start_time, end_time, location, notes, booker, price, calculated, maximum FROM schedules ORDER BY schedule_date DESC, start_time DESC');
        res.json({ success: true, schedules });
    } catch (err) {
        console.error('모든 일정 가져오기 에러:', err.message);
        res.status(500).json({ success: false, message: '일정 정보를 가져오는 중 오류가 발생했습니다.' });
    }
});

// API: 모든 경기 기록 가져오기
app.get('/api/admin/matchrecords', isAuthenticated, async (req, res) => {
    try {
        const [matchrecords] = await pool.query('SELECT id, date, court, team1_deuce, team1_ad, team2_deuce, team2_ad, team1_score, team2_score, etc FROM matchrecord ORDER BY date DESC, id DESC');
        res.json({ success: true, matchrecords });
    } catch (err) {
        console.error('모든 경기 기록 가져오기 에러:', err.message);
        res.status(500).json({ success: false, message: '경기 기록 정보를 가져오는 중 오류가 발생했습니다.' });
    }
});

// API: 모든 멤버 가져오기
app.get('/api/admin/members', isAuthenticated, async (req, res) => {
    try {
        const [members] = await pool.query('SELECT name, gender, etc, `order` FROM member ORDER BY `order` ASC, name ASC');
        res.json({ success: true, members });
    } catch (err) {
        console.error('모든 멤버 가져오기 에러:', err.message);
        res.status(500).json({ success: false, message: '멤버 정보를 가져오는 중 오류가 발생했습니다.' });
    }
});

// API: 특정 멤버 정보 가져오기
app.get('/api/admin/member/:name', isAuthenticated, async (req, res) => {
    const memberName = req.params.name;
    try {
        const [member] = await pool.query('SELECT name, gender, etc, `order` FROM member WHERE name = ?', [memberName]);
        if (member.length > 0) {
            res.json({ success: true, member: member[0] });
        } else {
            res.status(404).json({ success: false, message: '멤버를 찾을 수 없습니다.' });
        }
    } catch (err) {
        console.error('특정 멤버 정보 가져오기 에러:', err.message);
        res.status(500).json({ success: false, message: '멤버 정보를 가져오는 중 오류가 발생했습니다.' });
    }
});

const PORT = 8001;
app.listen(PORT, () => {
    console.log(`http://localhost:${PORT} 에서 서버 실행 중`);
});