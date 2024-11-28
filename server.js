// server.js

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs'); // 'bcrypt' 대신 'bcryptjs' 사용
const bodyParser = require('body-parser');
require('dotenv').config(); // dotenv 설정

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // 개발 단계에서는 모든 출처를 허용, 프로덕션에서는 특정 도메인으로 제한하는 것이 좋습니다.
        methods: ["GET", "POST"],
        credentials: true
    }
});
const PORT = process.env.PORT || 5000;

// CORS 설정
app.use(cors());

// 세션 설정
app.use(session({
    secret: process.env.SESSION_SECRET || 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // 프로덕션 환경에서는 true로 설정
        httpOnly: true,
        maxAge: 60 * 60 * 1000 // 1시간 유효
    }
}));

// Body Parser 설정
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// 정적 파일 서빙
app.use(express.static(path.join(__dirname, 'public')));

// 비밀번호 설정 및 해싱
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "xorhkd12!@";
const hashedPassword = bcrypt.hashSync(ADMIN_PASSWORD, 10);

// 인증 미들웨어
function isAuthenticated(req, res, next) {
    if (req.session.isAuthenticated) {
        next();
    } else {
        res.redirect('/login'); // 메인 페이지로 리디렉션
    }
}

// 메인 루트 라우트
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 로그인 페이지 라우트
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// 로그인 처리 라우트
app.post('/login', (req, res) => {
    const { password } = req.body;
    if (bcrypt.compareSync(password, hashedPassword)) {
        req.session.isAuthenticated = true;
        console.log('로그인 성공: 세션 설정 완료');
        res.redirect('/dashboard');
    } else {
        console.log('로그인 실패: 비밀번호 불일치');
        // 로그인 실패 시, 다시 로그인 페이지로 리디렉션하면서 에러 메시지 전달
        res.send(`
            <script>
                alert('비밀번호가 일치하지 않습니다.');
                window.location.href = '/login';
            </script>
        `);
    }
});

// 로그아웃 라우트
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.redirect('/dashboard');
        }
        res.redirect('/');
    });
});

// 대시보드 라우트 보호
app.get('/dashboard', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// 추가된 대시보드 내 페이지 라우트 보호
app.get('/dashboard/user-management', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'user-management.html'));
});

app.get('/dashboard/settings', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.get('/dashboard/reports', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'reports.html'));
});

// 클라이언트 상태를 저장하기 위한 객체
const clients = {};

// 목표 달성한 클라이언트를 저장할 배열
const goalAchievedClients = [];

// Socket.IO 이벤트 핸들링
io.on('connection', (socket) => {
    console.log('클라이언트가 연결되었습니다.');

    // 'user_info_update' 이벤트 처리
    socket.on('user_info_update', (data) => {
        console.log('사용자 정보 업데이트:', data);

        // 클라이언트 정보를 저장
        clients[socket.id] = {
            socket: socket,
            username: data.name,
            address: data.user_ip,
            server_status: data.server_status,
            isApproved: false, // 초기 승인 상태는 false
            cumulativeProfit: 0, // 초기 누적 수익금은 0
            targetProfit: 500, // 초기 목표 수익금은 500
            goalAchieved: false // 초기 목표 달성 상태는 false
        };

        // 웹페이지에 사용자 정보 전송
        io.emit('update_user_info', data);
    });

    // 'cumulative_profit' 이벤트 처리
    socket.on('cumulative_profit', (data) => {
        const { cumulativeProfit: clientProfit } = data;
        if (typeof clientProfit === 'number' && clientProfit >= 0 && clientProfit < 1e12) { // 예시 조건: 음수나 비정상적으로 큰 값 방지
            if (clients[socket.id]) {
                clients[socket.id].cumulativeProfit += clientProfit;
                console.log(`클라이언트 ${clients[socket.id].username}로부터 누적 수익금 수신: ${clientProfit} USDT`);
                console.log(`클라이언트 ${clients[socket.id].username}의 전체 누적 수익금: ${clients[socket.id].cumulativeProfit} USDT`);

                // 대시보드에 누적 수익금 업데이트 전송 (per client)
                io.emit('update_cumulative_profit', { name: clients[socket.id].username, cumulativeProfit: clients[socket.id].cumulativeProfit });

                // 목표 수익금과 비교
                if (clients[socket.id].cumulativeProfit >= clients[socket.id].targetProfit && !goalAchievedClients.includes(clients[socket.id].username)) {
                    console.log(`클라이언트 ${clients[socket.id].username}의 목표 수익금 달성!`);

                    // 목표 달성 목록에 추가
                    goalAchievedClients.push(clients[socket.id].username);
                    clients[socket.id].goalAchieved = true;

                    // 대시보드에 목표 달성 이벤트 전송
                    io.emit('goal_achieved', { name: clients[socket.id].username });

                    // "목표를 달성했습니다" 메시지 전송
                    io.emit('show_goal_message', { name: clients[socket.id].username, message: '목표를 달성했습니다' });
                }
            } else {
                console.log('누적 수익금 수신: 클라이언트 정보가 존재하지 않습니다.');
            }
        } else {
            console.log('잘못된 누적 수익금 데이터 수신:', data);
        }
    });

    // 'set_target_profit' 이벤트 처리
    socket.on('set_target_profit', (data) => {
        const { name, targetProfit } = data;
        if (typeof targetProfit === 'number' && targetProfit > 0) {
            // Find the client by name
            const targetSocketId = Object.keys(clients).find(id => clients[id].username === name);
            if (targetSocketId) {
                clients[targetSocketId].targetProfit = targetProfit;
                console.log(`클라이언트 ${name}의 목표 수익금이 ${targetProfit} USDT로 설정되었습니다.`);

                // 목표 달성 상태 리셋
                clients[targetSocketId].goalAchieved = false;
                const index = goalAchievedClients.indexOf(name);
                if (index !== -1) {
                    goalAchievedClients.splice(index, 1);
                }

                // 대시보드에 목표 수익금 업데이트 전송
                io.emit('update_target_profit', { name: name, targetProfit: targetProfit });
            } else {
                console.log(`목표 수익금 설정: 클라이언트 ${name}을(를) 찾을 수 없습니다.`);
            }
        } else {
            console.log('잘못된 목표 수익금 데이터 수신:', data);
        }
    });

    // 'keep_alive' 이벤트 처리
    socket.on('keep_alive', (data) => {
        console.log(`클라이언트 ${data.name}로부터 keep_alive 수신`);
        // 필요한 경우 추가 처리
    });

    // 'update_data' 이벤트 처리
    socket.on('update_data', (data) => {
        console.log('받은 데이터:', data);

        // 클라이언트 정보를 업데이트
        if (clients[socket.id]) {
            clients[socket.id].server_status = data.server_status;
        } else {
            // 클라이언트가 'user_info_update'를 보내지 않고 'update_data'를 보낸 경우 처리
            clients[socket.id] = {
                socket: socket,
                username: data.name,
                address: data.user_ip,
                server_status: data.server_status,
                isApproved: false, // 초기 승인 상태는 false
                cumulativeProfit: 0, // 초기 누적 수익금은 0
                targetProfit: 500, // 초기 목표 수익금은 500
                goalAchieved: false // 초기 목표 달성 상태는 false
            };
        }

        // 소수점 두 자리로 반올림
        const roundedData = { ...data };

        // 소수점 두 자리로 반올림할 필드 목록
        const numericFields = ['total_balance', 'current_profit_rate', 'unrealized_pnl', 'current_total_asset'];

        numericFields.forEach(field => {
            if (typeof roundedData[field] === 'number') {
                roundedData[field] = parseFloat(roundedData[field].toFixed(2));
            } else {
                roundedData[field] = null;  // 데이터가 없을 경우 null로 설정
            }
        });

        // 모든 클라이언트에게 데이터 브로드캐스트
        io.emit('update_data', roundedData);
    });

    // 클라이언트로부터 승인 또는 승인취소 명령을 수신
    socket.on('send_command', (data) => {
        const { command, name } = data;
        // 해당 이름의 클라이언트를 찾습니다.
        const targetClient = Object.values(clients).find(client => client.username === name);

        if (targetClient) {
            // 승인 상태 업데이트
            if (command === 'approve') {
                targetClient.isApproved = true;
            } else if (command === 'cancel_approve') {
                targetClient.isApproved = false;
                // 목표 달성 상태 리셋
                targetClient.goalAchieved = false;
                const index = goalAchievedClients.indexOf(targetClient.username);
                if (index !== -1) {
                    goalAchievedClients.splice(index, 1);
                }
            }

            // 클라이언트에게 명령 전송
            targetClient.socket.emit(command, { message: `${command} 명령이 서버에서 전송되었습니다.` });
            console.log(`클라이언트 ${name}에게 ${command} 명령을 전송했습니다.`);

            // 모든 클라이언트에게 승인 상태 업데이트 전송
            io.emit('update_approval_status', { name: targetClient.username, isApproved: targetClient.isApproved });
        } else {
            console.log(`클라이언트 ${name}을(를) 찾을 수 없습니다.`);
        }
    });

    // 클라이언트 연결 해제 시
    socket.on('disconnect', () => {
        console.log('클라이언트 연결이 해제되었습니다.');

        // 해당 클라이언트의 정보가 있으면 삭제
        if (clients[socket.id]) {
            const disconnectedUser = clients[socket.id];
            delete clients[socket.id];

            // 웹페이지에 사용자 상태 업데이트
            const disconnectData = {
                name: disconnectedUser.username,
                user_ip: disconnectedUser.address,
                server_status: 'Disconnected',
                timestamp: new Date().toISOString().slice(0, 19).replace('T', ' ')
            };
            io.emit('update_user_info', disconnectData);
        }
    });
});

// 서버 시작
server.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});
