// db.js
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');
const db = new Database(dbPath, { foreign_keys: true }); // 외래 키 활성화

// 사용자 테이블 생성
db.prepare(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        address TEXT NOT NULL,
        server_status TEXT NOT NULL,
        isApproved INTEGER DEFAULT 0,
        cumulativeProfit REAL DEFAULT 0,
        targetProfit REAL DEFAULT 500,
        goalAchieved INTEGER DEFAULT 0,
        socketId TEXT UNIQUE,
        lastActive DATETIME DEFAULT CURRENT_TIMESTAMP,
        total_balance REAL DEFAULT 0,
        current_profit_rate REAL DEFAULT 0,
        unrealized_pnl REAL DEFAULT 0,
        current_total_asset REAL DEFAULT 0
    )
`).run();

// 거래 내역 테이블 생성
db.prepare(`
    CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        type TEXT NOT NULL,
        symbol TEXT NOT NULL,
        amount REAL NOT NULL,
        price REAL NOT NULL,
        profit REAL DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(username) REFERENCES users(username)
    )
`).run();

// 수익 기록 테이블 생성
db.prepare(`
    CREATE TABLE IF NOT EXISTS profit_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        dailyProfit REAL NOT NULL,
        cumulativeProfit REAL NOT NULL,
        tradeCount INTEGER DEFAULT 0,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(username) REFERENCES users(username)
    )
`).run();

// 연결 기록 테이블 생성
db.prepare(`
    CREATE TABLE IF NOT EXISTS connection_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        status TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        disconnectReason TEXT,
        FOREIGN KEY(username) REFERENCES users(username)
    )
`).run();

// 인덱스 추가
db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_trades_username ON trades(username)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_profit_history_username ON profit_history(username)`).run();
db.prepare(`CREATE INDEX IF NOT EXISTS idx_connection_history_username ON connection_history(username)`).run();

module.exports = db;
