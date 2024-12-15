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
const db = require('./db'); // SQLite 데이터베이스 모듈

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
    origin: "https://port-0-sinaid-server-m1onak5031836227.sel4.cloudtype.app", // 실제 도메인으로 변경
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
        secure: true, // HTTPS 사용 시 true로 설정
        httpOnly: true,
        maxAge: 60 * 60 * 1000 // 1시간
    }
}));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "https://port-0-sinaid-server-m1onak5031836227.sel4.cloudtype.app", // 실제 도메인으로 변경
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

// ConnectionManager 클래스 정의
class ConnectionManager {
    constructor() {
        this.connections = new Map();
        this.heartbeatInterval = 20000; // 20초
        this.maxReconnectAttempts = 5;
        this.cleanupInterval = 300000; // 5분
        this.startCleanup();
    }

    addConnection(socketId, clientInfo) {
        this.connections.set(socketId, {
            ...clientInfo,
            lastActive: Date.now(),
            reconnectAttempts: 0,
            status: 'Connected'
        });
    }

    removeConnection(socketId) {
        this.connections.delete(socketId);
    }

    updateLastActive(socketId) {
        const connection = this.connections.get(socketId);
        if (connection) {
            connection.lastActive = Date.now();
        }
    }

    async handleStaleConnections() {
        const staleThreshold = Date.now() - this.heartbeatInterval * 3;
        for (const [socketId, connection] of this.connections) {
            if (connection.lastActive < staleThreshold) {
                try {
                    const user = db.prepare('SELECT * FROM users WHERE socketId = ?').get(socketId);
                    if (user) {
                        db.prepare(`
                            UPDATE users 
                            SET server_status = 'Disconnected', lastActive = CURRENT_TIMESTAMP
                            WHERE socketId = ?
                        `).run(socketId);

                        db.prepare(`
                            INSERT INTO connection_history (username, status, disconnectReason)
                            VALUES (?, 'Disconnected', 'Stale connection')
                        `).run(user.username);
                    }
                    this.removeConnection(socketId);
                    logger.warn(`Stale connection removed: ${socketId}`);
                } catch (error) {
                    logger.error('Stale connection cleanup error:', error);
                }
            }
        }
    }

    startCleanup() {
        setInterval(() => {
            this.handleStaleConnections();
        }, this.cleanupInterval);
    }

    async reconnect(socketId, username) {
        const connection = this.connections.get(socketId);
        if (connection) {
            if (connection.reconnectAttempts >= this.maxReconnectAttempts) {
                this.removeConnection(socketId);
                return false;
            }
            connection.reconnectAttempts += 1;
            return true;
        }
        return false;
    }

    getConnectionInfo(socketId) {
        return this.connections.get(socketId);
    }

    getAllConnections() {
        return Array.from(this.connections.entries());
    }
}

// TradeManager 클래스 정의
class TradeManager {
    constructor() {
        this.activeTrades = new Map();
    }

    async recordTrade(tradeData) {
        try {
            // 거래 기록 삽입
            const insertTradeStmt = db.prepare(`
                INSERT INTO trades (username, type, symbol, amount, price, profit)
                VALUES (@username, @type, @symbol, @amount, @price, @profit)
            `);
            insertTradeStmt.run(tradeData);

            // 수익 기록 업데이트
            await this.updateProfitHistory(tradeData);

            // 목표 달성 여부 확인 (서버는 이제 cumulativeProfit을 클라이언트에서 받은 값으로 설정)
            const user = db.prepare('SELECT * FROM users WHERE username = ?').get(tradeData.username);
            if (user && !user.goalAchieved && user.cumulativeProfit >= user.targetProfit) {
                db.prepare(`
                    UPDATE users 
                    SET goalAchieved = 1 
                    WHERE username = ?
                `).run(tradeData.username);
                return { goalAchieved: true, username: tradeData.username };
            }

            return { goalAchieved: false };
        } catch (error) {
            logger.error('거래 기록 오류:', error);
            return { goalAchieved: false };
        }
    }

    async updateProfitHistory(tradeData) {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

        try {
            let profitRecord = db.prepare(`
                SELECT * FROM profit_history 
                WHERE username = ? AND timestamp >= ? AND timestamp < ?
            `).get(tradeData.username, todayStart.toISOString(), todayEnd.toISOString());

            if (!profitRecord) {
                // 새로운 수익 기록 삽입
                db.prepare(`
                    INSERT INTO profit_history (username, dailyProfit, cumulativeProfit, tradeCount)
                    VALUES (?, ?, ?, ?)
                `).run(tradeData.username, tradeData.profit, tradeData.profit, 1);
            } else {
                // 기존 수익 기록 업데이트
                db.prepare(`
                    UPDATE profit_history 
                    SET dailyProfit = dailyProfit + ?, 
                        cumulativeProfit = cumulativeProfit + ?, 
                        tradeCount = tradeCount + 1
                    WHERE id = ?
                `).run(tradeData.profit, tradeData.profit, profitRecord.id);
            }

            return { goalAchieved: false };
        } catch (error) {
            logger.error('수익 기록 업데이트 오류:', error);
            return { goalAchieved: false };
        }
    }

    async getTradeHistory(username, startDate, endDate) {
        try {
            return db.prepare(`
                SELECT * FROM trades 
                WHERE username = ? AND timestamp >= ? AND timestamp <= ?
                ORDER BY timestamp DESC
            `).all(username, new Date(startDate).toISOString(), new Date(endDate).toISOString());
        } catch (error) {
            logger.error('거래 내역 조회 오류:', error);
            throw error;
        }
    }
}

const tradeManager = new TradeManager();
const connectionManager = new ConnectionManager();

// Socket.IO 이벤트 처리
io.on('connection', async (socket) => {
    logger.info(`새로운 클라이언트 연결: ${socket.id}`);

    const heartbeat = setInterval(() => {
        if (socket.connected) {
            socket.emit('heartbeat');
        }
    }, connectionManager.heartbeatInterval);

    socket.on('heartbeat-response', async () => {
        try {
            connectionManager.updateLastActive(socket.id);
            const user = db.prepare('SELECT * FROM users WHERE socketId = ?').get(socket.id);
            if (user) {
                db.prepare(`
                    UPDATE users 
                    SET lastActive = CURRENT_TIMESTAMP 
                    WHERE socketId = ?
                `).run(socket.id);
            }
        } catch (error) {
            logger.error('하트비트 업데이트 오류:', error);
        }
    });

    // 초기 데이터 요청
    socket.on('request_initial_data', async () => {
        try {
            const users = db.prepare('SELECT * FROM users').all();
            const allUserData = users.map(user => ({
                name: user.username,
                user_ip: user.address,
                total_balance: user.total_balance || 0,
                current_profit_rate: user.current_profit_rate || 0,
                unrealized_pnl: user.unrealized_pnl || 0,
                current_total_asset: user.current_total_asset || 0,
                server_status: user.server_status,
                timestamp: new Date(user.lastActive).toISOString(),
                cumulative_profit: user.cumulativeProfit || 0,
                target_profit: user.targetProfit || 500,
                isApproved: user.isApproved ? true : false
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

            let user = db.prepare('SELECT * FROM users WHERE username = ?').get(data.name);

            if (!user) {
                // 새로운 사용자 삽입
                db.prepare(`
                    INSERT INTO users (username, address, server_status, socketId)
                    VALUES (?, ?, ?, ?)
                `).run(data.name, data.user_ip, data.server_status, socket.id);
            } else {
                // 기존 사용자 업데이트
                db.prepare(`
                    UPDATE users 
                    SET socketId = ?, server_status = ?, lastActive = CURRENT_TIMESTAMP 
                    WHERE username = ?
                `).run(socket.id, data.server_status, data.name);
            }

            connectionManager.addConnection(socket.id, {
                username: data.name,
                status: data.server_status
            });

            const updatedUser = db.prepare('SELECT * FROM users WHERE username = ?').get(data.name);
            const broadcastData = {
                name: updatedUser.username,
                user_ip: updatedUser.address,
                server_status: updatedUser.server_status,
                timestamp: new Date(updatedUser.lastActive).toISOString(),
                cumulative_profit: updatedUser.cumulativeProfit || 0,
                target_profit: updatedUser.targetProfit || 500,
                isApproved: updatedUser.isApproved ? true : false
            };

            io.emit('update_user_info', broadcastData);

        } catch (error) {
            logger.error('사용자 정보 업데이트 오류:', error);
            socket.emit('error', { message: '사용자 정보 업데이트 중 오류가 발생했습니다.' });
        }
    });

    // 거래 실행 처리
    socket.on('trade_executed', async (data) => {
        try {
            const tradeResult = await tradeManager.recordTrade({
                username: data.name,
                type: data.type,
                symbol: data.symbol,
                amount: data.amount,
                price: data.price,
                profit: data.profit
            });

            if (tradeResult.goalAchieved) {
                io.emit('goal_achieved', {
                    name: tradeResult.username
                });
            }

            // 서버는 이제 'cumulativeProfit'을 클라이언트로부터 받기 때문에 여기서 별도로 보내지 않습니다.
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

            db.prepare(`
                UPDATE users 
                SET 
                    lastActive = CURRENT_TIMESTAMP,
                    total_balance = ?, 
                    current_profit_rate = ?, 
                    unrealized_pnl = ?, 
                    current_total_asset = ?, 
                    server_status = ?,
                    cumulativeProfit = ?
                WHERE username = ?
            `).run(
                data.total_balance,
                data.current_profit_rate,
                data.unrealized_pnl,
                data.current_total_asset,
                data.server_status || 'Connected',
                data.cumulative_profit, // 클라이언트에서 보낸 cumulative_profit을 설정
                data.name
            );

            logger.info(`사용자 ${data.name}의 누적 수익금 업데이트: ${data.cumulative_profit}`);

            const user = db.prepare('SELECT * FROM users WHERE username = ?').get(data.name);
            if (user) {
                const realizedProfit = user.cumulativeProfit || 0;
                const unrealized = parseFloat(user.unrealized_pnl) || 0;
                const displayProfit = realizedProfit + unrealized;

                const broadcastData = {
                    name: user.username,
                    total_balance: Number(user.total_balance).toFixed(2),
                    current_profit_rate: Number(user.current_profit_rate).toFixed(2),
                    unrealized_pnl: Number(user.unrealized_pnl).toFixed(2),
                    current_total_asset: Number(user.current_total_asset).toFixed(2),
                    server_status: user.server_status,
                    timestamp: new Date().toISOString(),
                    cumulative_profit: user.cumulativeProfit || 0,
                    display_profit: displayProfit.toFixed(2),
                    isApproved: user.isApproved ? true : false
                };

                io.emit('update_data', broadcastData);
            }
        } catch (error) {
            logger.error('데이터 업데이트 오류:', error);
            socket.emit('error', { message: '데이터 업데이트 중 오류가 발생했습니다.' });
        }
    });

    // 명령 전송 처리
    socket.on('send_command', async (data) => {
        try {
            const { command, name } = data;
            if (!command || !name) {
                socket.emit('error', { message: '명령 또는 사용자 이름이 누락되었습니다.' });
                return;
            }

            const user = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
            if (user) {
                if (command === 'approve') {
                    db.prepare(`
                        UPDATE users 
                        SET isApproved = 1, lastActive = CURRENT_TIMESTAMP 
                        WHERE username = ?
                    `).run(name);
                } else if (command === 'cancel_approve') {
                    db.prepare(`
                        UPDATE users 
                        SET isApproved = 0, goalAchieved = 0, lastActive = CURRENT_TIMESTAMP 
                        WHERE username = ?
                    `).run(name);
                }

                const updatedUser = db.prepare('SELECT * FROM users WHERE username = ?').get(name);

                if (updatedUser.socketId) {
                    io.to(updatedUser.socketId).emit(command, {
                        message: `${command} 명령이 전송되었습니다.`
                    });
                }

                // 승인 상태 업데이트를 클라이언트에 전송
                io.emit('update_approval_status', {
                    name: updatedUser.username,
                    isApproved: updatedUser.isApproved ? true : false
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

            db.prepare(`
                UPDATE users 
                SET targetProfit = ?, lastActive = CURRENT_TIMESTAMP 
                WHERE username = ?
            `).run(targetProfit, name);

            // 목표 수익금 업데이트를 클라이언트에 전송
            io.emit('update_target_profit', {
                name,
                targetProfit
            });

            // 목표 수익금이 변경된 사용자의 데이터를 다시 전송
            const user = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
            const displayProfit = (user.cumulativeProfit || 0) + (user.unrealized_pnl || 0);

            io.emit('update_data', {
                name: user.username,
                total_balance: user.total_balance || 0,
                current_profit_rate: user.current_profit_rate || 0,
                unrealized_pnl: user.unrealized_pnl || 0,
                current_total_asset: user.current_total_asset || 0,
                server_status: user.server_status,
                timestamp: new Date().toISOString(),
                cumulative_profit: user.cumulativeProfit || 0,
                display_profit: displayProfit.toFixed(2),
                isApproved: user.isApproved ? true : false
            });
        } catch (error) {
            logger.error('목표 수익 설정 오류:', error);
            socket.emit('error', { message: '목표 수익 설정 중 오류가 발생했습니다.' });
        }
    });

    // 보고서 요청 처리
    socket.on('request_reports', async (data) => {
        try {
            const { username, startDate, endDate } = data;
            const trades = db.prepare(`
                SELECT * FROM trades 
                WHERE username = ? AND timestamp >= ? AND timestamp <= ?
                ORDER BY timestamp DESC
            `).all(username, new Date(startDate).toISOString(), new Date(endDate).toISOString());

            const statistics = calculateStatistics(trades);

            socket.emit('reports_data', {
                trades,
                statistics
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
            const user = db.prepare('SELECT * FROM users WHERE socketId = ?').get(socket.id);
            if (user) {
                db.prepare(`
                    UPDATE users 
                    SET server_status = 'Disconnected', socketId = NULL, lastActive = CURRENT_TIMESTAMP 
                    WHERE socketId = ?
                `).run(socket.id);

                db.prepare(`
                    INSERT INTO connection_history (username, status, disconnectReason)
                    VALUES (?, 'Disconnected', 'Client disconnected')
                `).run(user.username);

                io.emit('update_user_info', {
                    name: user.username,
                    user_ip: user.address,
                    server_status: 'Disconnected',
                    timestamp: new Date().toISOString(),
                    cumulative_profit: user.cumulativeProfit || 0,
                    target_profit: user.targetProfit || 500,
                    isApproved: user.isApproved ? true : false
                });
            }

            connectionManager.removeConnection(socket.id);
            logger.info(`클라이언트 연결 해제: ${socket.id}`);
        } catch (error) {
            logger.error('연결 해제 처리 오류:', error);
        }
    });
});

// 통계 계산 함수
function calculateStatistics(trades) {
    if (!trades.length) {
        return {
            totalTrades: 0,
            totalProfit: 0,
            winRate: 0,
            averageProfit: 0,
            bestTrade: 0,
            worstTrade: 0
        };
    }

    const winningTrades = trades.filter(trade => trade.profit > 0);
    const totalProfit = trades.reduce((sum, trade) => sum + trade.profit, 0);

    return {
        totalTrades: trades.length,
        totalProfit: Number(totalProfit.toFixed(2)),
        winRate: Number((winningTrades.length / trades.length * 100).toFixed(2)),
        averageProfit: Number((totalProfit / trades.length).toFixed(2)),
        bestTrade: Number(Math.max(...trades.map(t => t.profit)).toFixed(2)),
        worstTrade: Number(Math.min(...trades.map(t => t.profit)).toFixed(2))
    };
}

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
    const activeConnections = connectionManager.getAllConnections();
    for (const [socketId, connection] of activeConnections) {
        try {
            const socket = io.sockets.sockets.get(socketId);
            if (socket) {
                socket.disconnect(true);
            }
        } catch (error) {
            logger.error(`소켓 연결 종료 중 오류 (${socketId}):`, error);
        }
    }

    try {
        db.close();
        logger.info('SQLite 연결 종료');
    } catch (error) {
        logger.error('SQLite 연결 종료 오류:', error);
    }

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
    const activeConnections = connectionManager.getAllConnections();
    logger.info(`활성 연결 수: ${activeConnections.length}`);
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

// 통계 계산 함수가 필요 없을 경우 제거할 수 있지만, 현재 유지
