import mysql, { type Pool } from "mysql2/promise";
import { CREATE_TABLES_SQL } from "./db-schema";
import type { DatabaseClient } from "./types";

export interface MysqlConfig {
	host?: string;
	port?: number;
	user?: string;
	password?: string;
	database?: string;
	uri?: string;
}

export function parseMysqlEnv(): MysqlConfig {
	const uri = process.env.MYSQL_URL || process.env.DATABASE_URL;
	return {
		uri,
		host: process.env.MYSQL_HOST || "localhost",
		port: Number.parseInt(process.env.MYSQL_PORT || "3306", 10),
		user: process.env.MYSQL_USER || "root",
		password: process.env.MYSQL_PASSWORD || "",
		database: process.env.MYSQL_DATABASE || "fluxgate",
	};
}

export class MysqlDatabaseClient implements DatabaseClient {
	readonly pool: Pool;

	constructor(pool: Pool) {
		this.pool = pool;
	}

	async query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
		const [rows] = await this.pool.query(sql, params);
		return rows as T[];
	}

	async queryRow<T = any>(sql: string, params: any[] = []): Promise<T | null> {
		const [rows] = await this.pool.query(sql, params);
		const list = rows as T[];
		return list.length > 0 ? list[0] : null;
	}

	async execute(sql: string, params: any[] = []): Promise<void> {
		await this.pool.execute(sql, params);
	}
}

export function createDatabasePool(config: MysqlConfig): Pool {
	if (config.uri) {
		return mysql.createPool(config.uri);
	}

	return mysql.createPool({
		host: config.host,
		port: config.port,
		user: config.user,
		password: config.password,
		database: config.database,
		waitForConnections: true,
		connectionLimit: 10,
		queueLimit: 0,
		enableKeepAlive: true,
		keepAliveInitialDelay: 10000,
	});
}

export async function initDatabase(db: DatabaseClient): Promise<void> {
	for (const statement of CREATE_TABLES_SQL) {
		await db.execute(statement);
	}
	try {
		await db.execute("ALTER TABLE sources ADD COLUMN type VARCHAR(32) NOT NULL DEFAULT 'url' AFTER user_id");
	} catch {}
	try {
		await db.execute("ALTER TABLE sources MODIFY COLUMN v2ray_url_encrypted MEDIUMTEXT NULL");
	} catch {}
	try {
		await db.execute("ALTER TABLE sources MODIFY COLUMN clash_url_encrypted MEDIUMTEXT NULL");
	} catch {}
}
