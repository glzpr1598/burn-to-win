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

// Base64 인코딩/디코딩 함수 추가(mysql 5.1 버전에서 utf8mb4를 지원하지 않아 db에 저장할 때 base64로 인코딩, 읽을 때 디코딩)
const encodeBase64 = (str) => {
    if (!str) return str; // null, undefined, 빈 문자열은 그대로 반환
    return Buffer.from(str, 'utf8').toString('base64');
};

const decodeBase64 = (str) => {
    if (!str) return str; // null, undefined, 빈 문자열은 그대로 반환
    try {
        // Base64 형식인지 간단히 확인하고, 아니면 원본 반환 (선택적)
        const isBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(str);
        if (!isBase64) return str;

        return Buffer.from(str, 'base64').toString('utf8');
    } catch (e) {
        // 디코딩 실패 시 (예: 이미 일반 텍스트인 경우) 원본 문자열 반환
        console.warn('Base64 decoding failed for:', str, 'Returning original string.');
        return str;
    }
};

// --- 라우트 핸들러 ---

// 홈화면 -> 일정 페이지로 리디렉션
app.get('/', (req, res) => {
    res.redirect('/schedule');
});

// 경기 기록
app.get('/match-record', async (req, res) => {
    try {
        // 1. 경기 기록과 회원 정보를 병렬로 가져옵니다.
        const matchesPromise = pool.query('SELECT * FROM matchrecord ORDER BY date DESC, court ASC, id DESC');
        const membersPromise = pool.query('SELECT name, gender FROM member');
        const [[matches], [members]] = await Promise.all([matchesPromise, membersPromise]);

        // 2. 이름으로 성별을 쉽게 찾을 수 있는 객체(genderMap)를 만듭니다.
        const genderMap = members.reduce((acc, member) => {
            acc[member.name] = member.gender;
            return acc;
        }, {});

        // 3. 경기 기록(matches)과 성별 맵(genderMap)을 템플릿에 전달합니다.
        res.render('match-record', {
            matches: matches,
            genderMap: genderMap,
            currentPage: 'match-record'
        });
    } catch (err) {
        console.error('[/match-record] 에러:', err.message);
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
        // ✨ 수정: 회원의 이름과 성별을 함께 조회하도록 변경
        const membersPromise = pool.query('SELECT name, gender FROM member WHERE etc = "" ORDER BY name ASC');
        const matchesPromise = pool.query('SELECT * FROM matchrecord WHERE team1_result IS NOT NULL');
        const courtsPromise = pool.query("SELECT DISTINCT court AS name FROM matchrecord WHERE court IS NOT NULL AND court != '' ORDER BY name ASC");

        const [[members], [allMatches], [courts]] = await Promise.all([membersPromise, matchesPromise, courtsPromise]);

        // ✨ 추가: 이름으로 성별을 쉽게 찾기 위한 genderMap 객체 생성
        const genderMap = members.reduce((acc, member) => {
            acc[member.name] = member.gender;
            return acc;
        }, {});

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

        // ✨ 수정: 렌더링 시 genderMap을 함께 전달
        res.render('my-score', { scores, courts, genderMap, currentPage: 'my-score' });

    } catch (err) {
        console.error('[/my-score] 에러:', err.message);
        res.status(500).send('서버 오류가 발생했습니다.');
    }
});

// API: 특정 선수의 모든 경기 기록 조회
app.get('/api/matches/player/:name', async (req, res) => {
    try {
        const { name } = req.params;
        let { period, types, courts: courtFilter } = req.query;

        const [allMatches] = await pool.query('SELECT * FROM matchrecord WHERE team1_result IS NOT NULL ORDER BY date DESC, id DESC');

        let filteredMatches = applyPeriodFilter(allMatches, period);
        if (types && types !== '전체') {
            filteredMatches = filteredMatches.filter(m => types.split(',').includes(m.type));
        }
        if (courtFilter) {
            filteredMatches = filteredMatches.filter(m => courtFilter.split(',').includes(m.court));
        }

        const playerMatches = filteredMatches.filter(match => {
            return [match.team1_deuce, match.team1_ad, match.team2_deuce, match.team2_ad].includes(name);
        });
        
        // ✨ 추가: 경기 참여 선수들의 성별 정보 가져오기
        const playerNames = new Set();
        playerMatches.forEach(m => {
            if (m.team1_deuce) playerNames.add(m.team1_deuce);
            if (m.team1_ad) playerNames.add(m.team1_ad);
            if (m.team2_deuce) playerNames.add(m.team2_deuce);
            if (m.team2_ad) playerNames.add(m.team2_ad);
        });

        let genderMap = {};
        if (playerNames.size > 0) {
            const [genderRows] = await pool.query(
                `SELECT name, gender FROM member WHERE name IN (?)`,
                [[...playerNames]]
            );
            genderMap = genderRows.reduce((acc, member) => {
                acc[member.name] = member.gender;
                return acc;
            }, {});
        }

        // ✨ 수정: 경기 기록과 성별 맵을 함께 전송
        res.json({ matches: playerMatches, genderMap });

    } catch (err) {
        console.error(`[/api/matches/player/${req.params.name}] 에러:`, err.message);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// 상대와 케미 페이지
app.get('/chemistry', async (req, res) => {
    try {
        // ✨ 수정: 회원의 이름과 성별을 함께 조회
        const membersPromise = pool.query('SELECT name, gender FROM member WHERE etc = "" ORDER BY name ASC');
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
                    const stats = {
                        // ✨ 수정: 비교 대상의 이름과 성별을 함께 저장
                        name: compareMember.name,
                        gender: compareMember.gender,
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

                        if ((isBaseOnTeam1 && isCompareOnTeam1) || (isBaseOnTeam2 && isCompareOnTeam2)) {
                            stats.sameTeamMatches++;
                            const result = isBaseOnTeam1 ? match.team1_result : match.team2_result;
                            if (result === '승') stats.sameTeamWins++;
                            else if (result === '패') stats.sameTeamLosses++;
                            else if (result === '무') stats.sameTeamDraws++;
                        }
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
            const winRateDiff = sameTeamWinRate - opponentWinRate;

            return {
                ...stats,
                sameTeamWinRate,
                opponentWinRate,
                winRateDiff
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
        // ✨ 모든 회원의 이름과 성별 정보를 가져오는 쿼리로 변경
        const allMembersPromise = pool.query("SELECT name, gender FROM member");
        const regularMembersPromise = pool.query("SELECT name FROM member WHERE `order` = 0");

        const [[allMatches], [courts], [allMembers], [regularMembers]] = await Promise.all([matchesPromise, courtsPromise, allMembersPromise, regularMembersPromise]);

        // ✨ 모든 회원의 성별 정보를 담은 Map 생성
        const genderMap = allMembers.reduce((acc, member) => {
            acc[member.name] = member.gender;
            return acc;
        }, {});

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
                const isRegularPair = players.every(p => regularMemberSet.has(p));
                if (!isRegularPair) return;

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
            const [player1, player2] = key.split('/');

            return {
                // ✨ 기존 키(예: "김철수/박영희")는 data 속성용으로 유지
                pairKey: key,
                // ✨ 템플릿에서 사용할 선수 정보와 성별을 구조화하여 추가
                players: [
                    { name: player1, gender: genderMap[player1] },
                    { name: player2, gender: genderMap[player2] }
                ],
                matches: stats.matches,
                wins: stats.wins,
                losses: stats.losses,
                winRate
            };
        });

        res.render('chemistry-score', { pairData, courts, currentPage: 'chemistry-score' });

    } catch (err) {
        console.error('[/chemistry-score] 에러:', err.message);
        res.status(500).send('서버 오류가 발생했습니다.');
    }
});

// API: 특정 페어의 경기 기록 조회
app.get('/api/matches/pair', async (req, res) => {
    try {
        let { pair, period, types, courts: courtFilter } = req.query;
        if (!pair) {
            return res.status(400).json({ message: '페어 정보가 필요합니다.' });
        }
        const [player1, player2] = pair.split('/');

        const [allMatches] = await pool.query('SELECT * FROM matchrecord WHERE team1_result IS NOT NULL');

        let filteredMatches = applyPeriodFilter(allMatches, period);
        if (types) {
            filteredMatches = filteredMatches.filter(m => types.split(',').includes(m.type));
        }
        if (courtFilter) {
            filteredMatches = filteredMatches.filter(m => courtFilter.split(',').includes(m.court));
        }

        const pairMatches = filteredMatches.filter(match => {
            const team1 = [match.team1_deuce, match.team1_ad];
            const team2 = [match.team2_deuce, match.team2_ad];
            return (team1.includes(player1) && team1.includes(player2)) || (team2.includes(player1) && team2.includes(player2));
        });

        pairMatches.sort((a, b) => new Date(b.date) - new Date(a.date) || b.id - a.id);

        // ✨ 추가: 경기 참여 선수들의 성별 정보 가져오기
        const playerNames = new Set();
        pairMatches.forEach(m => {
            if (m.team1_deuce) playerNames.add(m.team1_deuce);
            if (m.team1_ad) playerNames.add(m.team1_ad);
            if (m.team2_deuce) playerNames.add(m.team2_deuce);
            if (m.team2_ad) playerNames.add(m.team2_ad);
        });

        let genderMap = {};
        if (playerNames.size > 0) {
            const [genderRows] = await pool.query(
                `SELECT name, gender FROM member WHERE name IN (?)`,
                [[...playerNames]]
            );
            genderMap = genderRows.reduce((acc, member) => {
                acc[member.name] = member.gender;
                return acc;
            }, {});
        }

        // ✨ 수정: 경기 기록과 성별 맵을 함께 전송
        res.json({ matches: pairMatches, genderMap });

    } catch (err) {
        console.error('[/api/matches/pair] 에러:', err.message);
        res.status(500).json({ error: '서버 오류가 발생했습니다.' });
    }
});

// API: 케미 분석용 경기 기록 조회
app.get('/api/matches/chemistry', async (req, res) => {
    try {
        let { player1, player2, period, types, courts: courtFilter } = req.query;
        if (!player1 || !player2) {
            return res.status(400).json({ message: '두 명의 플레이어 정보가 필요합니다.' });
        }

        const [allMatches] = await pool.query('SELECT * FROM matchrecord WHERE team1_result IS NOT NULL');
        
        let filteredMatches = applyPeriodFilter(allMatches, period);
        if (types) {
            filteredMatches = filteredMatches.filter(m => types.split(',').includes(m.type));
        }
        if (courtFilter) {
            filteredMatches = filteredMatches.filter(m => courtFilter.split(',').includes(m.court));
        }

        const chemistryMatches = filteredMatches.filter(match => {
            const playersInMatch = [match.team1_deuce, match.team1_ad, match.team2_deuce, match.team2_ad].filter(p => p);
            return playersInMatch.includes(player1) && playersInMatch.includes(player2);
        });
        
        chemistryMatches.sort((a, b) => new Date(b.date) - new Date(a.date) || b.id - a.id);
        
        // ✨ 추가: 경기 참여 선수들의 성별 정보 가져오기
        const playerNames = new Set();
        chemistryMatches.forEach(m => {
            if (m.team1_deuce) playerNames.add(m.team1_deuce);
            if (m.team1_ad) playerNames.add(m.team1_ad);
            if (m.team2_deuce) playerNames.add(m.team2_deuce);
            if (m.team2_ad) playerNames.add(m.team2_ad);
        });

        let genderMap = {};
        if (playerNames.size > 0) {
            const [genderRows] = await pool.query(
                `SELECT name, gender FROM member WHERE name IN (?)`,
                [[...playerNames]]
            );
            genderMap = genderRows.reduce((acc, member) => {
                acc[member.name] = member.gender;
                return acc;
            }, {});
        }

        // ✨ 수정: 경기 기록과 성별 맵을 함께 전송
        res.json({ matches: chemistryMatches, genderMap });

    } catch (err) {
        console.error('[/api/matches/chemistry] 에러:', err.message);
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

        // ✨ 수정: 정회원 목록 조회 시 성별(gender) 정보도 함께 가져옵니다.
        const membersPromise = pool.query('SELECT name, gender FROM member WHERE `order` = 0 ORDER BY name ASC');
        const attendanceRecordsPromise = pool.query(
            `SELECT sa.member_name, s.schedule_date
            FROM schedule_attendees sa
            JOIN schedules s ON sa.schedule_id = s.id
            WHERE s.schedule_date BETWEEN ? AND ?`,
            [startDate, endDate]
        );

        const [[members], [records]] = await Promise.all([membersPromise, attendanceRecordsPromise]);

        // 회원별로 출석일 데이터를 가공합니다.
        const attendanceByMember = new Map();
        records.forEach(record => {
            const day = new Date(record.schedule_date).getDate();
            if (!attendanceByMember.has(record.member_name)) {
                attendanceByMember.set(record.member_name, new Set());
            }
            attendanceByMember.get(record.member_name).add(day);
        });

        // ✨ 수정: 최종 데이터 생성 시 성별 정보도 함께 포함시킵니다.
        const attendanceData = members.map(member => {
            const attendedDates = attendanceByMember.get(member.name) || new Set();
            return {
                name: member.name,
                gender: member.gender, // 성별 정보 추가
                attendanceCount: attendedDates.size,
                attendedDays: Array.from(attendedDates).sort((a, b) => a - b).join(', ')
            };
        });

        // EJS 템플릿을 렌더링합니다.
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

        const latestNoticePromise = pool.query('SELECT created_at FROM notices ORDER BY created_at DESC LIMIT 1');

        // 1. 로그인 드롭다운용 (기존 유지)
        const membersForDropdownPromise = pool.query('SELECT name FROM member WHERE etc = "" ORDER BY name ASC');
        // 2. 성별 배경색 적용을 위한 전체 회원 정보
        const allMembersForGenderPromise = pool.query('SELECT name, gender FROM member');

        const schedulesPromise = pool.query(
            `SELECT s.*, g.group_name
            FROM schedules s
            LEFT JOIN group_list g ON s.group_id = g.id
            WHERE s.schedule_date BETWEEN ? AND ?
            ORDER BY s.schedule_date ASC, s.start_time ASC, s.location ASC`,
            [startDate, endDate]
        );

        const [[[latestNotice]], [membersForDropdown], [allMembers], [schedules]] = await Promise.all([
            latestNoticePromise,
            membersForDropdownPromise,
            allMembersForGenderPromise,
            schedulesPromise
        ]);

        const latestNoticeDate = latestNotice ? latestNotice.created_at : null;

        const genderMap = allMembers.reduce((acc, member) => {
            acc[member.name] = member.gender;
            return acc;
        }, {});

        if (schedules.length > 0) {
            const scheduleIds = schedules.map(s => s.id);

            const attendeesPromise = pool.query(`SELECT schedule_id, member_name FROM schedule_attendees WHERE schedule_id IN (?)`, [scheduleIds]);
            const commentsPromise = pool.query(`SELECT * FROM schedule_comments WHERE schedule_id IN (?) ORDER BY created_at ASC`, [scheduleIds]);
            const groupMembersPromise = pool.query(`
                SELECT gm.group_id, m.name
                FROM group_member gm
                JOIN member m ON gm.member_id = m.id`);
            const [[attendees], [comments], [allGroupMembers]] = await Promise.all([attendeesPromise, commentsPromise, groupMembersPromise]);

            const attendeesMap = new Map();
            attendees.forEach(att => {
                const list = attendeesMap.get(att.schedule_id) || [];
                list.push(att.member_name);
                attendeesMap.set(att.schedule_id, list);
            });

            const commentsMap = new Map();
            comments.forEach(comment => {
                const list = commentsMap.get(comment.schedule_id) || [];
                comment.created_at = formatDateTime(comment.created_at);
                comment.comment = decodeBase64(comment.comment);
                list.push(comment);
                commentsMap.set(comment.schedule_id, list);
            });

            const groupMembersMap = new Map();
            allGroupMembers.forEach(gm => {
                const list = groupMembersMap.get(gm.group_id) || [];
                list.push(gm.name);
                groupMembersMap.set(gm.group_id, list);
            });

            const scheduleData = schedules.map(schedule => ({
                ...schedule,
                attendees: attendeesMap.get(schedule.id) || [],
                comments: commentsMap.get(schedule.id) || [],
                allowed_members: schedule.group_id ? (groupMembersMap.get(schedule.group_id) || []) : []
            }));

            res.render('schedule', { year, month, members: membersForDropdown, schedules: scheduleData, genderMap, currentPage: 'schedule', latestNoticeDate });

        } else {
            res.render('schedule', { year, month, members: membersForDropdown, schedules: [], genderMap, currentPage: 'schedule', latestNoticeDate });
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
        const encodedComment = encodeBase64(comment);
        const sql = 'INSERT INTO schedule_comments (schedule_id, member_name, comment) VALUES (?, ?, ?)';
        const [result] = await pool.query(sql, [schedule_id, member_name, encodedComment]);
        const [rows] = await pool.query('SELECT * FROM schedule_comments WHERE id = ?', [result.insertId]);
        const newComment = rows[0];
        // 날짜 포맷 변경
        newComment.comment = decodeBase64(newComment.comment);
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
        res.redirect('/admin?message=비밀번호가 일치하지 않습니다.');
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
            res.json({ success: true, message: `경기 기록(ID: ${matchId})이 삭제되었습니다.` });
        } else {
            res.status(404).json({ success: false, message: `경기 기록(ID: ${matchId})을 찾을 수 없습니다.` });
        }
    } catch (err) {
        console.error('경기 기록 삭제 에러:', err.message);
        res.status(500).json({ success: false, message: '경기 기록 삭제 중 오류가 발생했습니다.' });
    }
});

// 일정 등록
app.post('/admin/add-schedule', isAuthenticated, async (req, res) => {
    const { schedule_date, start_time, end_time, location, notes, booker, price, maximum, group_id } = req.body;
    try {
        const [result] = await pool.query(
            'INSERT INTO schedules (schedule_date, start_time, end_time, location, notes, booker, price, maximum, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [schedule_date, start_time, end_time, location, notes, booker || null, price || null, maximum || 6, group_id || null]
        );
        res.json({ success: true, message: `일정(ID: ${result.insertId})이 성공적으로 등록되었습니다.` });
    } catch (err) {
        console.error('일정 등록 에러:', err.message);
        res.status(500).json({ success: false, message: '일정 등록 중 오류가 발생했습니다.' });
    }
});

// 일정 수정
app.post('/admin/update-schedule', isAuthenticated, async (req, res) => {
    const { id, schedule_date, start_time, end_time, location, notes, booker, price, calculated, maximum, group_id } = req.body;
    try {
        const [result] = await pool.query(
            'UPDATE schedules SET schedule_date = ?, start_time = ?, end_time = ?, location = ?, notes = ?, booker = ?, price = ?, calculated = ?, maximum = ?, group_id = ? WHERE id = ?',
            [schedule_date, start_time, end_time, location, notes, booker || null, price || null, calculated, maximum || 6, group_id || null, id]
        );
        if (result.affectedRows > 0) {
            res.json({ success: true, message: `일정(ID: ${id})이 성공적으로 수정되었습니다.` });
        } else {
            res.status(404).json({ success: false, message: `일정(ID: ${id})을 찾을 수 없습니다.` });
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
            res.json({ success: true, message: `일정(ID: ${scheduleId})이 삭제되었습니다.` });
        } else {
            res.status(404).json({ success: false, message: `일정(ID: ${scheduleId})을 찾을 수 없습니다.` });
        }
    } catch (err) {
        console.error('일정 삭제 에러:', err.message);
        res.status(500).json({ success: false, message: '일정 삭제 중 오류가 발생했습니다.' });
    }
});

// 멤버 등록
app.post('/admin/add-member', isAuthenticated, async (req, res) => {
    // birth와 phone을 req.body에서 받아옴
    const { name, gender, birth, phone, etc, order } = req.body;
    try {
        // 기본 비밀번호 '0000'을 해싱하여 저장
        const hashedPassword = await bcrypt.hash('0000', saltRounds);
        // INSERT 쿼리에 birth, phone 추가
        const [result] = await pool.query(
            'INSERT INTO member (name, gender, birth, phone, etc, `order`, password) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, gender, birth || null, phone || null, etc || '', order || 0, hashedPassword]
        );
        res.json({ success: true, message: `멤버 ${name}이(가) 성공적으로 등록되었습니다.` });
    } catch (err) {
        console.error('멤버 등록 에러:', err.message);
        res.status(500).json({ success: false, message: '멤버 등록 중 오류가 발생했습니다.' });
    }
});

// 멤버 수정
app.post('/admin/update-member', isAuthenticated, async (req, res) => {
    // birth와 phone을 req.body에서 받아옴
    const { originalName, name, gender, birth, phone, etc, order } = req.body;
    try {
        // UPDATE 쿼리에 birth, phone 추가
        const [result] = await pool.query(
            'UPDATE member SET name = ?, gender = ?, birth = ?, phone = ?, etc = ?, `order` = ? WHERE name = ?',
            [name, gender, birth || null, phone || null, etc || '', order || 0, originalName]
        );
        if (result.affectedRows > 0) {
            res.json({ success: true, message: `${name}이(가) 성공적으로 수정되었습니다.` });
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

// [신규] 그룹 관리 API
app.get('/api/admin/groups', isAuthenticated, async (req, res) => {
    try {
        const [groups] = await pool.query('SELECT * FROM group_list ORDER BY group_name ASC');
        res.json({ success: true, groups });
    } catch (err) {
        res.status(500).json({ success: false, message: '그룹 목록 조회 실패' });
    }
});

app.post('/api/admin/groups', isAuthenticated, async (req, res) => {
    const { groupName } = req.body;
    try {
        const [result] = await pool.query('INSERT INTO group_list (group_name) VALUES (?)', [groupName]);
        res.json({ success: true, message: '그룹이 추가되었습니다.', insertId: result.insertId });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: '이미 존재하는 그룹 이름입니다.' });
        }
        res.status(500).json({ success: false, message: '그룹 추가 실패' });
    }
});

app.get('/api/admin/groups/:id/members', isAuthenticated, async (req, res) => {
    try {
        const [members] = await pool.query(
            'SELECT m.id, m.name FROM member m JOIN group_member gm ON m.id = gm.member_id WHERE gm.group_id = ? ORDER BY m.name ASC',
            [req.params.id]
        );
        res.json({ success: true, members });
    } catch (err) {
        res.status(500).json({ success: false, message: '그룹 멤버 조회 실패' });
    }
});

app.post('/api/admin/groups/members', isAuthenticated, async (req, res) => {
    const { groupId, memberId } = req.body;
    try {
        await pool.query('INSERT INTO group_member (group_id, member_id) VALUES (?, ?)', [groupId, memberId]);
        res.json({ success: true, message: '그룹에 멤버가 추가되었습니다.' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: '이미 그룹에 속한 멤버입니다.' });
        }
        res.status(500).json({ success: false, message: '멤버 추가 실패' });
    }
});

app.post('/api/admin/groups/members/delete', isAuthenticated, async (req, res) => {
    const { groupId, memberIds } = req.body;
    if (!memberIds || memberIds.length === 0) {
        return res.status(400).json({ success: false, message: '삭제할 멤버를 선택하세요.' });
    }
    try {
        const placeholders = memberIds.map(() => '?').join(',');
        await pool.query(`DELETE FROM group_member WHERE group_id = ? AND member_id IN (${placeholders})`, [groupId, ...memberIds]);
        res.json({ success: true, message: '선택한 멤버가 그룹에서 삭제되었습니다.' });
    } catch (err) {
        res.status(500).json({ success: false, message: '멤버 삭제 실패' });
    }
});

app.post('/api/admin/groups/delete', isAuthenticated, async (req, res) => {
    const { groupId } = req.body;
    if (!groupId) {
        return res.status(400).json({ success: false, message: '그룹 ID가 필요합니다.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction(); // 트랜잭션 시작

        // 1. 그룹에 속한 멤버들을 먼저 삭제합니다.
        await connection.query('DELETE FROM group_member WHERE group_id = ?', [groupId]);

        // 2. 그룹 자체를 삭제합니다.
        await connection.query('DELETE FROM group_list WHERE id = ?', [groupId]);

        await connection.commit(); // 트랜잭션 커밋

        res.json({ success: true, message: '그룹이 성공적으로 삭제되었습니다.' });
    } catch (err) {
        if (connection) await connection.rollback(); // 오류 발생 시 롤백
        console.error('그룹 삭제 에러:', err.message);
        res.status(500).json({ success: false, message: '그룹 삭제 중 오류가 발생했습니다.' });
    } finally {
        if (connection) connection.release();
    }
});

// API: 모든 일정 가져오기
app.get('/api/admin/schedules', isAuthenticated, async (req, res) => {
    try {
        const [schedules] = await pool.query(`
            SELECT s.*, g.group_name 
            FROM schedules s 
            LEFT JOIN group_list g ON s.group_id = g.id 
            ORDER BY s.schedule_date DESC, s.start_time DESC
        `);
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
        const [members] = await pool.query('SELECT id, name, gender, birth, phone, etc, `order` FROM member ORDER BY `order` ASC, name ASC');
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
        const [member] = await pool.query('SELECT name, gender, birth, phone, etc, `order` FROM member WHERE name = ?', [memberName]);
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

// ✨ [추가] API: 특정 일정의 참석자 목록 가져오기
app.get('/api/admin/schedule/:id/attendees', isAuthenticated, async (req, res) => {
    const { id } = req.params;
    try {
        const [attendees] = await pool.query(
            'SELECT member_name FROM schedule_attendees WHERE schedule_id = ? ORDER BY member_name ASC',
            [id]
        );
        res.json({ success: true, attendees: attendees.map(a => a.member_name) });
    } catch (err) {
        console.error('[/api/admin/schedule/:id/attendees] 에러:', err.message);
        res.status(500).json({ success: false, message: '참석자 정보를 가져오는 중 오류가 발생했습니다.' });
    }
});

// ✨ [추가] API: 일정에 참석자 추가 (관리자용)
app.post('/api/admin/schedule/add-attendee', isAuthenticated, async (req, res) => {
    const { scheduleId, memberName } = req.body;
    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        // 참석자 추가
        await connection.query(
            'INSERT INTO schedule_attendees (schedule_id, member_name) VALUES (?, ?)',
            [scheduleId, memberName]
        );
        // 로그 기록
        await connection.query(
            'INSERT INTO schedule_attendance_log (schedule_id, member_name, action) VALUES (?, ?, ?)',
            [scheduleId, memberName, 'attend(admin)']
        );

        await connection.commit();
        res.json({ success: true, message: `${memberName} 님을 참석 처리했습니다.` });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('[/api/admin/schedule/add-attendee] 에러:', err.message);
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ success: false, message: '이미 참석자 명단에 있습니다.' });
        }
        res.status(500).json({ success: false, message: '참석자 추가 중 오류가 발생했습니다.' });
    } finally {
        if (connection) connection.release();
    }
});

// ✨ [추가] API: 일정에서 참석자 삭제 (관리자용)
app.post('/api/admin/schedule/delete-attendees', isAuthenticated, async (req, res) => {
    const { scheduleId, memberNames } = req.body;
    if (!memberNames || memberNames.length === 0) {
        return res.status(400).json({ success: false, message: '삭제할 참석자를 선택하세요.' });
    }

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const placeholders = memberNames.map(() => '?').join(',');
        const params = [scheduleId, ...memberNames];

        // 참석자 삭제
        await connection.query(
            `DELETE FROM schedule_attendees WHERE schedule_id = ? AND member_name IN (${placeholders})`,
            params
        );
        // 로그 기록
        for (const memberName of memberNames) {
            await connection.query(
                'INSERT INTO schedule_attendance_log (schedule_id, member_name, action) VALUES (?, ?, ?)',
                [scheduleId, memberName, 'cancel(admin)']
            );
        }
        await connection.commit();
        res.json({ success: true, message: `${memberNames.join(', ')} 님을 참석 취소했습니다.` });
    } catch (err) {
        if (connection) await connection.rollback();
        console.error('[/api/admin/schedule/delete-attendees] 에러:', err.message);
        res.status(500).json({ success: false, message: '참석자 삭제 중 오류가 발생했습니다.' });
    } finally {
        if (connection) connection.release();
    }
});

// API: 특정 월의 유예 신청 목록 조회
app.get('/api/postponements/:year/:month', async (req, res) => {
    const { year, month } = req.params;
    try {
        const sql = `
            SELECT id, member_name, content, created_at 
            FROM postpone 
            WHERE year = ? AND month = ? 
            ORDER BY created_at ASC
        `;
        const [posts] = await pool.query(sql, [year, month]);

        posts.forEach(p => {
            p.content = decodeBase64(p.content);
            p.created_at = formatDateTime(p.created_at);
        });

        res.json({ success: true, posts });
    } catch (err) {
        console.error('[/api/postponements/:year/:month] 에러:', err.message);
        res.status(500).json({ success: false, message: '데이터 조회 중 오류가 발생했습니다.' });
    }
});

// API: 유예 신청 글 작성
app.post('/api/postponements', async (req, res) => {
    const { year, month, memberName, content } = req.body;
    if (!year || !month || !memberName || !content) {
        return res.status(400).json({ success: false, message: '모든 필드를 입력해야 합니다.' });
    }
    try {
        const encodedContent = encodeBase64(content);

        const insertSql = 'INSERT INTO postpone (year, month, member_name, content) VALUES (?, ?, ?, ?)';
        const [result] = await pool.query(insertSql, [year, month, memberName, encodedContent]);

        const selectSql = 'SELECT id, member_name, content, created_at FROM postpone WHERE id = ?';
        const [[newPost]] = await pool.query(selectSql, [result.insertId]);
        newPost.content = decodeBase64(newPost.content);
        newPost.created_at = formatDateTime(newPost.created_at);

        res.status(201).json({ success: true, post: newPost, message: '유예 신청이 등록되었습니다.' });
    } catch (err) {
        console.error('[/api/postponements] 에러:', err.message);
        res.status(500).json({ success: false, message: '등록 중 오류가 발생했습니다.' });
    }
});

// API: 유예 신청 글 삭제
app.delete('/api/postponements/:id', async (req, res) => {
    const { id } = req.params;
    const { memberName } = req.body;

    if (!memberName) {
        return res.status(401).json({ success: false, message: '로그인이 필요합니다.' });
    }

    try {
        const [[post]] = await pool.query('SELECT member_name FROM postpone WHERE id = ?', [id]);
        if (!post) {
            return res.status(404).json({ success: false, message: '삭제할 게시글이 없습니다.' });
        }
        if (post.member_name !== memberName) {
            return res.status(403).json({ success: false, message: '본인이 작성한 글만 삭제할 수 있습니다.' });
        }

        await pool.query('DELETE FROM postpone WHERE id = ?', [id]);
        res.json({ success: true, message: '게시글을 삭제했습니다.' });

    } catch (err) {
        console.error(`[/api/postponements/:id] 에러:`, err.message);
        res.status(500).json({ success: false, message: '삭제 중 오류가 발생했습니다.' });
    }
});

// --- 회원 명단 관련 라우트 ---

// 회원 명단 페이지 렌더링
app.get('/member-list', async (req, res) => {
    try {
        // 로그인 드롭다운에 필요한 전체 회원 이름과, 명단 테이블에 필요한 상세 정보를 각각 조회
        const [allMemberNames] = await pool.query('SELECT name FROM member WHERE `order` = 0 ORDER BY name ASC');
        const [fullMemberList] = await pool.query('SELECT id, name, gender, birth, phone FROM member WHERE `order` = 0 ORDER BY name ASC');

        res.render('member-list', {
            members: allMemberNames,      // 로그인 드롭다운 목록용
            memberList: fullMemberList,   // 명단 테이블 표시용
            currentPage: 'member-list'
        });
    } catch (err) {
        console.error('[/member-list] GET 에러:', err.message);
        res.status(500).send('회원 명단 페이지를 불러오는 중 오류가 발생했습니다.');
    }
});

// API: 회원 명단 로그인 처리
app.post('/api/member/login', async (req, res) => {
    const { name, password } = req.body;
    if (!name || !password) {
        return res.status(400).json({ success: false, message: '이름과 비밀번호를 입력하세요.' });
    }
    try {
        const [rows] = await pool.query('SELECT id, name, password FROM member WHERE name = ?', [name]);
        if (rows.length === 0) {
            return res.status(401).json({ success: false, message: '존재하지 않는 회원입니다.' });
        }
        const member = rows[0];
        // bcrypt.compare로 암호화된 비밀번호 비교
        const match = await bcrypt.compare(password, member.password);

        if (match) {
            // 로그인 성공 시, 클라이언트에 필요한 최소한의 정보(id, name) 전송
            res.json({ success: true, member: { id: member.id, name: member.name } });
        } else {
            res.status(401).json({ success: false, message: '비밀번호가 일치하지 않습니다.' });
        }
    } catch (err) {
        console.error('[/api/member/login] POST 에러:', err.message);
        res.status(500).json({ success: false, message: '로그인 처리 중 오류가 발생했습니다.' });
    }
});

// API: 회원 정보 수정
app.post('/api/member/update', async (req, res) => {
    // 클라이언트에서 보낸 수정할 정보
    const { id, name, gender, birth, phone } = req.body;

    if (!id || !name) {
         return res.status(400).json({ success: false, message: '사용자 정보가 올바르지 않습니다.' });
    }

    try {
        // 보안 강화: 정보를 수정하려는 사용자의 id와 이름이 DB와 일치하는지 확인
        const [verifyRows] = await pool.query('SELECT name FROM member WHERE id = ?', [id]);
        if (verifyRows.length === 0 || verifyRows[0].name !== name) {
             return res.status(403).json({ success: false, message: '정보를 수정할 권한이 없습니다.' });
        }

        // DB 업데이트 쿼리 실행
        const sql = 'UPDATE member SET gender = ?, birth = ?, phone = ? WHERE id = ?';
        const [result] = await pool.query(sql, [gender, birth, phone, id]);

        if (result.affectedRows > 0) {
            res.json({ success: true, message: '정보가 성공적으로 수정되었습니다.' });
        } else {
            res.status(404).json({ success: false, message: '회원 정보를 찾을 수 없습니다.' });
        }
    } catch (err) {
        console.error('[/api/member/update] POST 에러:', err.message);
        res.status(500).json({ success: false, message: '정보 수정 중 오류가 발생했습니다.' });
    }
});

// --- 공지사항 관련 라우트 ---

// 공지사항 페이지 렌더링
app.get('/notice', async (req, res) => {
    try {
        // 로그인 드롭다운에 필요한 전체 회원 이름 조회
        const [members] = await pool.query('SELECT name FROM member ORDER BY `order` ASC, name ASC');
        
        // 모든 공지사항과 각 공지사항에 달린 댓글 수를 함께 조회
        const noticeSql = `
            SELECT 
                n.id, n.title, n.content, n.author, n.created_at,
                (SELECT COUNT(*) FROM notice_comments nc WHERE nc.notice_id = n.id) as comment_count
            FROM notices n 
            ORDER BY n.created_at DESC
        `;
        const [notices] = await pool.query(noticeSql);

        notices.forEach(n => {
            n.title = decodeBase64(n.title);
            n.content = decodeBase64(n.content);
            n.created_at = formatDateTime(n.created_at);
        });

        res.render('notice', {
            members: members,
            notices: notices,
            currentPage: 'notice'
        });
    } catch (err) {
        console.error('[/notice] GET 에러:', err.message);
        res.status(500).send('공지사항 페이지를 불러오는 중 오류가 발생했습니다.');
    }
});

// API: 특정 공지사항의 상세 정보 (내용 + 댓글) 조회
app.get('/api/notices/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const noticeSql = 'SELECT * FROM notices WHERE id = ?';
        const commentSql = 'SELECT * FROM notice_comments WHERE notice_id = ? ORDER BY created_at ASC';

        const [[notice]] = await pool.query(noticeSql, [id]);
        const [comments] = await pool.query(commentSql, [id]);

        if (!notice) {
            return res.status(404).json({ success: false, message: '게시글을 찾을 수 없습니다.' });
        }

        // Base64 디코딩 적용
        notice.title = decodeBase64(notice.title);
        notice.content = decodeBase64(notice.content);
        notice.created_at = formatDateTime(notice.created_at);
        comments.forEach(c => {
            c.comment = decodeBase64(c.comment); // 댓글 내용 디코딩
            c.created_at = formatDateTime(c.created_at);
        });

        res.json({ success: true, notice, comments });
    } catch (err) {
        console.error(`[/api/notices/:id] GET 에러:`, err.message);
        res.status(500).json({ success: false, message: '데이터 조회 중 오류 발생' });
    }
});


// API: 새 공지사항 작성
app.post('/api/notices', async (req, res) => {
    const { title, content, author } = req.body;
    if (!title || !content || !author) {
        return res.status(400).json({ success: false, message: '제목, 내용, 작성자 정보가 필요합니다.' });
    }
    try {
        // created_at에 NOW()를 사용하여 현재 시간을 명시적으로 삽입
        const encodedTitle = encodeBase64(title);
        const encodedContent = encodeBase64(content);

        const sql = 'INSERT INTO notices (title, content, author, created_at) VALUES (?, ?, ?, NOW())';
        const [result] = await pool.query(sql, [encodedTitle, encodedContent, author]);
        res.status(201).json({ success: true, message: '공지사항이 등록되었습니다.', insertId: result.insertId });
    } catch (err) {
        console.error('[/api/notices] POST 에러:', err.message);
        res.status(500).json({ success: false, message: '공지사항 등록 중 오류가 발생했습니다.' });
    }
});

// API: 공지사항 수정
app.put('/api/notices/:id', async (req, res) => {
    const { id } = req.params;
    const { title, content, author } = req.body;
    if (!title || !content || !author) {
        return res.status(400).json({ success: false, message: '필수 정보가 누락되었습니다.' });
    }
    try {
        const [[notice]] = await pool.query('SELECT author FROM notices WHERE id = ?', [id]);
        if (!notice) return res.status(404).json({ success: false, message: '수정할 게시글이 없습니다.' });
        if (notice.author !== author) return res.status(403).json({ success: false, message: '본인이 작성한 글만 수정할 수 있습니다.' });

        const encodedTitle = encodeBase64(title);
        const encodedContent = encodeBase64(content);

        const sql = 'UPDATE notices SET title = ?, content = ? WHERE id = ?';
        await pool.query(sql, [encodedTitle, encodedContent, id]);
        res.json({ success: true, message: '공지사항이 수정되었습니다.' });
    } catch (err) {
        console.error(`[/api/notices/:id] PUT 에러:`, err.message);
        res.status(500).json({ success: false, message: '공지사항 수정 중 오류가 발생했습니다.' });
    }
});


// API: 공지사항 삭제
app.delete('/api/notices/:id', async (req, res) => {
    const { id } = req.params;
    const { author } = req.body; // 본인 확인용 작성자 이름
    try {
        const [[notice]] = await pool.query('SELECT author FROM notices WHERE id = ?', [id]);
        if (!notice) {
            return res.status(404).json({ success: false, message: '삭제할 게시글이 없습니다.' });
        }
        if (notice.author !== author) {
            return res.status(403).json({ success: false, message: '본인이 작성한 글만 삭제할 수 있습니다.' });
        }
        await pool.query('DELETE FROM notices WHERE id = ?', [id]);
        res.json({ success: true, message: '공지사항이 삭제되었습니다.' });
    } catch (err) {
        console.error(`[/api/notices/:id] DELETE 에러:`, err.message);
        res.status(500).json({ success: false, message: '공지사항 삭제 중 오류가 발생했습니다.' });
    }
});

// API: 새 댓글 작성
app.post('/api/notice-comments', async (req, res) => {
    const { notice_id, author, comment } = req.body;
    if (!notice_id || !author || !comment) {
        return res.status(400).json({ success: false, message: '필수 정보가 누락되었습니다.' });
    }
    try {
        const encodedComment = encodeBase64(comment);
        const sql = 'INSERT INTO notice_comments (notice_id, author, comment) VALUES (?, ?, ?)';
        const [result] = await pool.query(sql, [notice_id, author, encodedComment]);
        const [[newComment]] = await pool.query('SELECT * FROM notice_comments WHERE id = ?', [result.insertId]);
        newComment.comment = decodeBase64(newComment.comment); // ✨ 댓글 내용 디코딩
        newComment.created_at = formatDateTime(newComment.created_at);
        res.status(201).json({ success: true, comment: newComment });
    } catch (err) {
        console.error('[/api/notice-comments] POST 에러:', err.message);
        res.status(500).json({ success: false, message: '댓글 작성 중 오류가 발생했습니다.' });
    }
});

// API: 댓글 삭제
app.delete('/api/notice-comments/:id', async (req, res) => {
    const { id } = req.params;
    const { author } = req.body; // 본인 확인용 작성자 이름
    try {
        const [[comment]] = await pool.query('SELECT author FROM notice_comments WHERE id = ?', [id]);
        if (!comment) {
            return res.status(404).json({ success: false, message: '삭제할 댓글이 없습니다.' });
        }
        if (comment.author !== author) {
            return res.status(403).json({ success: false, message: '본인이 작성한 댓글만 삭제할 수 있습니다.' });
        }
        await pool.query('DELETE FROM notice_comments WHERE id = ?', [id]);
        res.json({ success: true, message: '댓글이 삭제되었습니다.' });
    } catch (err) {
        console.error(`[/api/notice-comments/:id] DELETE 에러:`, err.message);
        res.status(500).json({ success: false, message: '댓글 삭제 중 오류가 발생했습니다.' });
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