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
const mongoose = require('mongoose');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const { createLogger, format, transports } = winston;
require('winston-daily-rotate-file');
const compression = require('compression');
const MongoStore = require('connect-mongo');

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
    origin: "https://port-0-sinaid-server-m1onak5031836227.sel4.cloudtype.app",
    methods: ["GET", "POST"],
    credentials: true
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(compression());

// 세션 설정(MongoDB 세션 스토어)
app.use(session({
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI || 'mongodb://sinaid:052929@svc.sel4.cloudtype.app:31003/sinid?authSource=admin',
        ttl: 60 * 60,
        autoRemove: 'native'
    }),
    secret: process.env.SESSION_SECRET || 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 60 * 60 * 1000
    }
}));

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "http://localhost:5000",
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    maxHttpBufferSize: 1e6
});

// MongoDB 연결
const mongoOptions = {
    maxPoolSize: 50,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    family: 4
};

mongoose.connect(process.env.MONGODB_URI || 'mongodb://sinaid:052929@svc.sel4.cloudtype.app:31003/sinid?authSource=admin', mongoOptions)
    .then(() => {
        logger.info('MongoDB 연결 성공');
    })
    .catch((err) => {
        logger.error('MongoDB 연결 오류:', err);
    });

mongoose.connection.on('error', (err) => {
    logger.error('MongoDB 연결 오류:', err);
});

mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB 연결 끊김. 재연결 시도...');
    setTimeout(() => {
        mongoose.connect(process.env.MONGODB_URI || 'mongodb://sinaid:052929@svc.sel4.cloudtype.app:31003/sinid?authSource=admin', mongoOptions)
            .catch(err => logger.error('MongoDB 재연결 실패:', err));
    }, 5000);
});

// 스키마 정의
const clientSchema = new mongoose.Schema({
    username: { type: String, unique: true, required: true },
    address: { type: String, required: true },
    server_status: { type: String, required: true },
    isApproved: { type: Boolean, default: false },
    cumulativeProfit: { type: Number, default: 0 }, // 누적 수익금 필드
    targetProfit: { type: Number, default: 500 },
    goalAchieved: { type: Boolean, default: false },
    socketId: { type: String, unique: true, sparse: true },
    lastActive: { type: Date, default: Date.now },
    connectionHistory: [{
        status: String,
        timestamp: { type: Date, default: Date.now },
        disconnectReason: String
    }],
    settings: {
        defaultTargetProfit: { type: Number, default: 500 },
        notificationsEnabled: { type: Boolean, default: true },
        riskLevel: { type: String, default: 'medium' }
    },
    total_balance: { type: Number, default: 0 },
    current_profit_rate: { type: Number, default: 0 },
    unrealized_pnl: { type: Number, default: 0 },
    current_total_asset: { type: Number, default: 0 }
});

const tradeHistorySchema = new mongoose.Schema({
    username: { type: String, required: true, index: true },
    type: { type: String, required: true },
    symbol: { type: String, required: true },
    amount: { type: Number, required: true },
    price: { type: Number, required: true },
    profit: { type: Number, default: 0 },
    timestamp: { type: Date, default: Date.now, index: true }
});

const profitHistorySchema = new mongoose.Schema({
    username: { type: String, required: true, index: true },
    dailyProfit: { type: Number, required: true },
    cumulativeProfit: { type: Number, required: true },
    tradeCount: { type: Number, default: 0 },
    timestamp: { type: Date, default: Date.now, index: true }
});

const Client = mongoose.model('Client', clientSchema);
const TradeHistory = mongoose.model('TradeHistory', tradeHistorySchema);
const ProfitHistory = mongoose.model('ProfitHistory', profitHistorySchema);

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
                    const client = await Client.findOne({ socketId: socketId });
                    if (client) {
                        client.server_status = 'Disconnected';
                        client.lastActive = new Date();
                        client.connectionHistory.push({
                            status: 'Disconnected',
                            timestamp: new Date(),
                            disconnectReason: 'Stale connection'
                        });
                        await client.save();
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

class TradeManager {
    constructor() {
        this.activeTrades = new Map();
    }

    async recordTrade(tradeData) {
        try {
            const trade = new TradeHistory({
                username: tradeData.username,
                type: tradeData.type,
                symbol: tradeData.symbol,
                amount: tradeData.amount,
                price: tradeData.price,
                profit: tradeData.profit
            });
            await trade.save();

            return await this.updateProfitHistory(tradeData);
        } catch (error) {
            logger.error('거래 기록 오류:', error);
            return { goalAchieved: false };
        }
    }

    async updateProfitHistory(tradeData) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        try {
            let profitRecord = await ProfitHistory.findOne({
                username: tradeData.username,
                timestamp: {
                    $gte: today,
                    $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
                }
            });

            if (!profitRecord) {
                profitRecord = new ProfitHistory({
                    username: tradeData.username,
                    dailyProfit: tradeData.profit,
                    cumulativeProfit: tradeData.profit,
                    tradeCount: 1
                });
            } else {
                profitRecord.dailyProfit += tradeData.profit;
                profitRecord.cumulativeProfit += tradeData.profit;
                profitRecord.tradeCount += 1;
            }

            await profitRecord.save();

            const client = await Client.findOne({ username: tradeData.username });
            if (client && !client.goalAchieved && profitRecord.cumulativeProfit >= client.targetProfit) {
                client.goalAchieved = true;
                await client.save();
                return { goalAchieved: true, username: client.username };
            }

            return { goalAchieved: false };
        } catch (error) {
            logger.error('수익 기록 업데이트 오류:', error);
            return { goalAchieved: false };
        }
    }

    async getTradeHistory(username, startDate, endDate) {
        try {
            return await TradeHistory.find({
                username,
                timestamp: {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate)
                }
            }).sort({ timestamp: -1 });
        } catch (error) {
            logger.error('거래 내역 조회 오류:', error);
            throw error;
        }
    }
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "xorhkd12!@";
const hashedPassword = bcrypt.hashSync(ADMIN_PASSWORD, 10);

function isAuthenticated(req, res, next) {
    if (req.session.isAuthenticated) {
        next();
    } else {
        res.redirect('/login');
    }
}

// 라우트
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

// 인스턴스 생성
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
            const client = await Client.findOne({ socketId: socket.id });
            if (client) {
                client.lastActive = new Date();
                await client.save();
            }
        } catch (error) {
            logger.error('하트비트 업데이트 오류:', error);
        }
    });

    // 초기 데이터 요청
    socket.on('request_initial_data', async () => {
        try {
            const clients = await Client.find({});
            const allUserData = clients.map(client => ({
                name: client.username,
                user_ip: client.address,
                total_balance: client.total_balance || 0,
                current_profit_rate: client.current_profit_rate || 0,
                unrealized_pnl: client.unrealized_pnl || 0,
                current_total_asset: client.current_total_asset || 0,
                server_status: client.server_status,
                timestamp: new Date().toISOString(),
                cumulative_profit: client.cumulativeProfit || 0,
                target_profit: client.targetProfit || 500,
                isApproved: client.isApproved || false
            }));
            socket.emit('initial_data', allUserData);
        } catch (error) {
            logger.error('초기 데이터 전송 오류:', error);
            socket.emit('error', { message: '초기 데이터 전송 중 오류가 발생했습니다.' });
        }
    });

    socket.on('user_info_update', async (data) => {
        try {
            if (!data.name || !data.user_ip || !data.server_status) {
                socket.emit('error', { message: '잘못된 사용자 정보 데이터입니다.' });
                return;
            }

            let client = await Client.findOne({ username: data.name });

            if (!client) {
                client = new Client({
                    username: data.name,
                    address: data.user_ip,
                    server_status: data.server_status,
                    socketId: socket.id,
                    connectionHistory: [{
                        status: 'Connected',
                        timestamp: new Date()
                    }]
                });
            } else {
                client.socketId = socket.id;
                client.server_status = data.server_status;
                client.lastActive = new Date();
                client.connectionHistory.push({
                    status: 'Connected',
                    timestamp: new Date()
                });
            }

            await client.save();

            connectionManager.addConnection(socket.id, {
                username: data.name,
                status: data.server_status
            });

            const broadcastData = {
                name: client.username,
                user_ip: client.address,
                server_status: client.server_status,
                timestamp: new Date().toISOString(),
                cumulative_profit: client.cumulativeProfit || 0
            };

            io.emit('update_user_info', broadcastData);

        } catch (error) {
            logger.error('사용자 정보 업데이트 오류:', error);
            socket.emit('error', { message: '사용자 정보 업데이트 중 오류가 발생했습니다.' });
        }
    });

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

            io.emit('trade_update', {
                username: data.name,
                trade: {
                    type: data.type,
                    symbol: data.symbol,
                    price: data.price,
                    amount: data.amount,
                    profit: data.profit,
                    timestamp: new Date()
                }
            });
        } catch (error) {
            logger.error('거래 실행 처리 오류:', error);
            socket.emit('error', { message: '거래 처리 중 오류가 발생했습니다.' });
        }
    });

    socket.on('update_data', async (data) => {
        try {
            if (!data.name) {
                socket.emit('error', { message: '사용자 이름이 누락되었습니다.' });
                return;
            }
    
            const client = await Client.findOneAndUpdate(
                { username: data.name },
                {
                    $set: {
                        lastActive: new Date(),
                        total_balance: data.total_balance,
                        current_profit_rate: data.current_profit_rate,
                        unrealized_pnl: data.unrealized_pnl,
                        current_total_asset: data.current_total_asset,
                        server_status: data.server_status || 'Connected',
                        cumulativeProfit: data.cumulative_profit // 실현 누적 이익 DB 반영
                    }
                },
                { new: true }
            );
    
            if (client) {
                // 실현 누적 이익 + 미실현 손익 합산
                const realizedProfit = client.cumulativeProfit || 0;
                const unrealized = parseFloat(data.unrealized_pnl) || 0;
                const displayProfit = realizedProfit + unrealized;
    
                const broadcastData = {
                    name: client.username,
                    total_balance: Number(data.total_balance).toFixed(2),
                    current_profit_rate: Number(data.current_profit_rate).toFixed(2),
                    unrealized_pnl: Number(data.unrealized_pnl).toFixed(2),
                    current_total_asset: Number(data.current_total_asset).toFixed(2),
                    server_status: client.server_status,
                    timestamp: new Date().toISOString(),
                    cumulative_profit: realizedProfit,    // 기존 실현 이익
                    display_profit: displayProfit.toFixed(2) // 실현 + 미실현 이익 합산한 값
                };
    
                io.emit('update_data', broadcastData);
            }
        } catch (error) {
            logger.error('데이터 업데이트 오류:', error);
            socket.emit('error', { message: '데이터 업데이트 중 오류가 발생했습니다.' });
        }
    });    

    socket.on('send_command', async (data) => {
        try {
            const { command, name } = data;
            if (!command || !name) {
                socket.emit('error', { message: '명령 또는 사용자 이름이 누락되었습니다.' });
                return;
            }

            const client = await Client.findOne({ username: name });
            if (client) {
                client.lastActive = new Date();
                if (command === 'approve') {
                    client.isApproved = true;
                } else if (command === 'cancel_approve') {
                    client.isApproved = false;
                    client.goalAchieved = false;
                }
                await client.save();

                if (client.socketId) {
                    io.to(client.socketId).emit(command, {
                        message: `${command} 명령이 전송되었습니다.`
                    });
                }

                io.emit('update_approval_status', {
                    name: client.username,
                    isApproved: client.isApproved
                });
            }
        } catch (error) {
            logger.error('명령 처리 오류:', error);
            socket.emit('error', { message: '명령 처리 중 오류가 발생했습니다.' });
        }
    });

    socket.on('set_target_profit', async (data) => {
        try {
            const { name, targetProfit } = data;
            if (typeof targetProfit !== 'number' || targetProfit <= 0) {
                socket.emit('error', { message: '잘못된 목표 수익 값입니다.' });
                return;
            }

            await Client.findOneAndUpdate(
                { username: name },
                {
                    $set: {
                        targetProfit,
                        lastActive: new Date()
                    }
                }
            );

            io.emit('update_target_profit', {
                name,
                targetProfit
            });
        } catch (error) {
            logger.error('목표 수익 설정 오류:', error);
            socket.emit('error', { message: '목표 수익 설정 중 오류가 발생했습니다.' });
        }
    });

    socket.on('request_reports', async (data) => {
        try {
            const { username, startDate, endDate } = data;
            const trades = await tradeManager.getTradeHistory(username, startDate, endDate);

            socket.emit('reports_data', {
                trades,
                statistics: calculateStatistics(trades)
            });
        } catch (error) {
            logger.error('보고서 데이터 조회 오류:', error);
            socket.emit('error', { message: '보고서 데이터 조회 중 오류가 발생했습니다.' });
        }
    });

    socket.on('disconnect', async () => {
        try {
            clearInterval(heartbeat);
            const client = await Client.findOne({ socketId: socket.id });
            if (client) {
                client.server_status = 'Disconnected';
                client.socketId = null;
                client.lastActive = new Date();
                client.connectionHistory.push({
                    status: 'Disconnected',
                    timestamp: new Date(),
                    disconnectReason: 'Client disconnected'
                });
                await client.save();

                io.emit('update_user_info', {
                    name: client.username,
                    user_ip: client.address,
                    server_status: 'Disconnected',
                    timestamp: new Date().toISOString(),
                    cumulative_profit: client.cumulativeProfit || 0
                });
            }

            connectionManager.removeConnection(socket.id);
            logger.info(`클라이언트 연결 해제: ${socket.id}`);
        } catch (error) {
            logger.error('연결 해제 처리 오류:', error);
        }
    });
});

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
        await mongoose.connection.close();
        logger.info('MongoDB 연결 종료');
    } catch (error) {
        logger.error('MongoDB 연결 종료 오류:', error);
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
