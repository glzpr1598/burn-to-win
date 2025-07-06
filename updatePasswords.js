const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const saltRounds = 10; // 암호화 복잡도

// web.js에 있는 DB 접속 정보를 그대로 가져옵니다.
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'burntowin.cafe24app.com',
    user: process.env.DB_USER || 'burntowin',
    password: process.env.DB_PASSWORD || 'qnfRhc1@',
    database: process.env.DB_NAME || 'burntowin',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

// 비밀번호 0000으로 업데이트
async function updateExistingPasswords() {
    console.log('기존 회원 비밀번호를 업데이트합니다...');
    try {
        // const [members] = await pool.query("SELECT name FROM member WHERE password IS NULL"); // 비밀번호 없는 멤버
        const [members] = await pool.query("SELECT name FROM member WHERE name = 'ㅇㅇㅇ'"); // 특정 멤버
        
        if (members.length === 0) {
            console.log('새로 업데이트할 회원이 없습니다.');
            return;
        }

        const defaultPassword = '0000';
        const hashedDefaultPassword = await bcrypt.hash(defaultPassword, saltRounds);
        
        for (const member of members) {
            await pool.query("UPDATE member SET password = ? WHERE name = ?", [hashedDefaultPassword, member.name]);
            console.log(`- ${member.name}님의 비밀번호가 '0000'으로 설정되었습니다.`);
        }
        console.log('업데이트 완료.');
    } catch (error) {
        console.error('비밀번호 업데이트 중 오류 발생:', error);
    } finally {
        await pool.end();
    }
}

updateExistingPasswords();