// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const { createLogger, format, transports } = winston;
require('winston-daily-rotate-file');
const compression = require('compression');

// 데이터베이스 관련 코드 제거
// const db = require('./db'); // 삭제

// 로깅 설정 (DailyRotateFile 사용)
const logTransport = new transports.DailyRotateFile({
    filename: 'app-%DATE%.log',
    dirname: 'logs',
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: '14d'
});

const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp(),
        format.json()
    ),
    transports: [
        logTransport,
        new transports.Console({ format: format.simple() })
    ]
});

const app = express();
app.use(cors({
    origin: "http://localhost:5000", // 실제 도메인으로 변경
    methods: ["GET", "POST"],
    credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(compression());

// 세션 설정 (MemoryStore 사용)
app.use(session({
    secret: process.env.SESSION_SECRET || 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // HTTPS 사용 시 true로 설정
        httpOnly: true,
        maxAge: 60 * 60 * 1000 // 1시간
    }
}));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "http://localhost:5000", // 실제 도메인으로 변경
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6
});

// 관리자 비밀번호 해싱
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "xorhkd12!@";
const hashedPassword = bcrypt.hashSync(ADMIN_PASSWORD, 10);

// 인증 미들웨어
function isAuthenticated(req, res, next) {
    if (req.session.isAuthenticated) {
        next();
    } else {
        res.redirect('/login');
    }
}

// 라우트 설정
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
    const { password } = req.body;
    logger.info('로그인 시도');

    if (bcrypt.compareSync(password, hashedPassword)) {
        req.session.isAuthenticated = true;
        logger.info('로그인 성공');
        res.redirect('/dashboard');
    } else {
        logger.warn('로그인 실패: 잘못된 비밀번호');
        res.send(`
            <script>
                alert('비밀번호가 일치하지 않습니다.');
                window.location.href = '/login';
            </script>
        `);
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            logger.error('로그아웃 중 오류:', err);
            return res.redirect('/dashboard');
        }
        logger.info('로그아웃 성공');
        res.redirect('/');
    });
});

app.get('/dashboard', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// 메모리에 사용자 상태 저장할 객체
// username을 key로 하여 {
//   name: string,
//   user_ip: string,
//   total_balance: number,
//   current_profit_rate: number,
//   unrealized_pnl: number,
//   current_total_asset: number,
//   server_status: string,
//   timestamp: string,
//   cumulative_profit: number,
//   target_profit: number,
//   isApproved: boolean
// } 형태로 저장
const usersData = {};

// Socket.IO 이벤트 처리
io.on('connection', async (socket) => {
    logger.info(`새로운 클라이언트 연결: ${socket.id}`);

    const heartbeat = setInterval(() => {
        if (socket.connected) {
            socket.emit('heartbeat');
        }
    }, 20000); // 20초마다 heartbeat

    socket.on('heartbeat-response', async () => {
        // 클라이언트 생존신호 처리
        // DB 제거로 인한 별도 처리 없음
    });

    // 초기 데이터 요청
    socket.on('request_initial_data', async () => {
        try {
            // usersData에 있는 모든 사용자 정보를 배열로 변환
            const allUserData = Object.values(usersData).map(user => ({
                name: user.name,
                user_ip: user.user_ip,
                total_balance: user.total_balance || 0,
                current_profit_rate: user.current_profit_rate || 0,
                unrealized_pnl: user.unrealized_pnl || 0,
                current_total_asset: user.current_total_asset || 0,
                server_status: user.server_status || 'Disconnected',
                timestamp: user.timestamp || new Date().toISOString(),
                cumulative_profit: user.cumulative_profit || 0,
                target_profit: user.target_profit || 500,
                isApproved: user.isApproved || false
            }));

            socket.emit('initial_data', allUserData);
        } catch (error) {
            logger.error('초기 데이터 전송 오류:', error);
            socket.emit('error', { message: '초기 데이터 전송 중 오류가 발생했습니다.' });
        }
    });

    // 사용자 정보 업데이트
    socket.on('user_info_update', async (data) => {
        try {
            if (!data.name || !data.user_ip || !data.server_status) {
                socket.emit('error', { message: '잘못된 사용자 정보 데이터입니다.' });
                return;
            }

            // DB 사용 안 하므로 메모리에 저장
            if (!usersData[data.name]) {
                usersData[data.name] = {};
            }

            usersData[data.name] = {
                ...usersData[data.name],
                name: data.name,
                user_ip: data.user_ip,
                server_status: data.server_status,
                timestamp: data.timestamp || new Date().toISOString(),
                // isApproved나 target_profit는 update_data에서 받을 수도 있고 이 이벤트에서 받을 수도 있음
                isApproved: (data.isApproved !== undefined) ? data.isApproved : (usersData[data.name].isApproved || false),
                target_profit: (data.target_profit !== undefined) ? data.target_profit : (usersData[data.name].target_profit || 500),
                display_profit: data.display_profit != null ? data.display_profit : (usersData[data.name].display_profit || 0),
                cumulative_profit: (data.cumulative_profit !== undefined) ? data.cumulative_profit : (usersData[data.name].cumulative_profit || 0)
            };

            io.emit('update_user_info', usersData[data.name]);
        } catch (error) {
            logger.error('사용자 정보 업데이트 오류:', error);
            socket.emit('error', { message: '사용자 정보 업데이트 중 오류가 발생했습니다.' });
        }
    });

    // 거래 실행 처리 (예제용: 실사용은 필요없을 수 있음)
    socket.on('trade_executed', async (data) => {
        try {
            // DB 제거, 여기서는 단순히 로그만
            logger.info(`거래 실행 데이터: ${JSON.stringify(data)}`);
            // 목표 달성 여부는 이제 처리하지 않음
        } catch (error) {
            logger.error('거래 실행 처리 오류:', error);
            socket.emit('error', { message: '거래 처리 중 오류가 발생했습니다.' });
        }
    });

    // 데이터 업데이트
    socket.on('update_data', async (data) => {
        try {
            if (!data.name) {
                socket.emit('error', { message: '사용자 이름이 누락되었습니다.' });
                return;
            }

            if (!usersData[data.name]) {
                usersData[data.name] = {};
            }

            usersData[data.name] = {
                ...usersData[data.name],
                name: data.name,
                user_ip: data.user_ip || usersData[data.name].user_ip,
                total_balance: data.total_balance || 0,
                current_profit_rate: data.current_profit_rate || 0,
                unrealized_pnl: data.unrealized_pnl || 0,
                current_total_asset: data.current_total_asset || 0,
                server_status: data.server_status || 'Connected',
                timestamp: data.timestamp || new Date().toISOString(),
                cumulative_profit: data.cumulative_profit || 0,
                display_profit: data.display_profit != null ? data.display_profit : (usersData[data.name].display_profit || 0),
                target_profit: data.target_profit || 500,
                isApproved: data.isApproved || false
            };

            logger.info(`사용자 ${data.name}의 상태 업데이트: ${JSON.stringify(usersData[data.name])}`);
            io.emit('update_data', usersData[data.name]);
        } catch (error) {
            logger.error('데이터 업데이트 오류:', error);
            socket.emit('error', { message: '데이터 업데이트 중 오류가 발생했습니다.' });
        }
    });

    // 명령 전송 처리 (승인/승인취소)
    socket.on('send_command', async (data) => {
        try {
            const { command, name } = data;
            if (!command || !name) {
                socket.emit('error', { message: '명령 또는 사용자 이름이 누락되었습니다.' });
                return;
            }

            // 여기서는 DB 없이 바로 해당 사용자에게 이벤트 전송
            // isApproved 상태는 사용자가 알아서 로컬에 저장
            if (command === 'approve') {
                io.emit('approve', { name: name });
                io.emit('update_approval_status', {
                    name: name,
                    isApproved: true
                });
            } else if (command === 'cancel_approve') {
                io.emit('cancel_approve', { name: name });
                io.emit('update_approval_status', {
                    name: name,
                    isApproved: false
                });
            }
        } catch (error) {
            logger.error('명령 처리 오류:', error);
            socket.emit('error', { message: '명령 처리 중 오류가 발생했습니다.' });
        }
    });

    // 목표 수익금 설정
    socket.on('set_target_profit', async (data) => {
        try {
            const { name, targetProfit } = data;
            if (typeof targetProfit !== 'number' || targetProfit <= 0) {
                socket.emit('error', { message: '잘못된 목표 수익 값입니다.' });
                return;
            }

            // 사용자가 로컬 JSON에 저장하므로 여기선 단순히 이벤트만 중계
            io.emit('set_target_profit', {
                name,
                targetProfit
            });

            // 메모리에도 반영 (사용자가 이후 업데이트 시 다시 반영 가능)
            if (!usersData[name]) {
                usersData[name] = {};
            }
            usersData[name].target_profit = targetProfit;
            logger.info(`목표 수익금 설정: ${name} - ${targetProfit} USDT`);

            // 변경된 사용자 데이터 다시 브로드캐스트
            io.emit('update_data', usersData[name]);
        } catch (error) {
            logger.error('목표 수익 설정 오류:', error);
            socket.emit('error', { message: '목표 수익 설정 중 오류가 발생했습니다.' });
        }
    });

    // 보고서 요청 처리 (DB 제거로 인하여 단순히 빈 데이터 반환)
    socket.on('request_reports', async (data) => {
        try {
            const { username, startDate, endDate } = data;
            // DB 미사용 -> 빈 값 반환
            socket.emit('reports_data', {
                trades: [],
                statistics: {
                    totalTrades: 0,
                    totalProfit: 0,
                    winRate: 0,
                    averageProfit: 0,
                    bestTrade: 0,
                    worstTrade: 0
                }
            });
        } catch (error) {
            logger.error('보고서 데이터 조회 오류:', error);
            socket.emit('error', { message: '보고서 데이터 조회 중 오류가 발생했습니다.' });
        }
    });

    // 연결 해제 처리
    socket.on('disconnect', async () => {
        try {
            clearInterval(heartbeat);
            // socketId로 사용자 식별 불가하므로 여기서는 별도 처리 없음
            // 실제로는 사용자별 socketId 매핑을 관리해 'Disconnected' 상태로 업데이트할 수 있음
            logger.info(`클라이언트 연결 해제: ${socket.id}`);
        } catch (error) {
            logger.error('연결 해제 처리 오류:', error);
        }
    });
});

// 에러 핸들링 미들웨어
app.use((err, req, res, next) => {
    logger.error('예상치 못한 오류:', err);
    res.status(500).json({
        success: false,
        error: '서버 오류가 발생했습니다.'
    });
});

// 비정상 종료 처리
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception:', error);
    setTimeout(() => {
        process.exit(1);
    }, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection:', reason);
});

// 정상 종료 처리
async function gracefulShutdown() {
    logger.info('서버 종료 시작...');
    // 메모리 정리 (특별히 할 것은 없음)
    server.close(() => {
        logger.info('서버가 안전하게 종료되었습니다.');
        process.exit(0);
    });

    setTimeout(() => {
        logger.error('서버 강제 종료');
        process.exit(1);
    }, 10000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// 서버 시작
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    logger.info(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});

// 주기적인 연결 상태 모니터링 (5분마다)
setInterval(() => {
    const activeCount = io.sockets.sockets.size;
    logger.info(`활성 연결 수: ${activeCount}`);
}, 300000);

// 메모리 사용량 모니터링 (15분마다)
setInterval(() => {
    const used = process.memoryUsage();
    logger.info('메모리 사용량:', {
        rss: `${Math.round(used.rss / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(used.heapTotal / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(used.heapUsed / 1024 / 1024)} MB`,
        external: `${Math.round(used.external / 1024 / 1024)} MB`
    });
}, 900000);
