# -*- coding: utf-8 -*-
"""数据库连接与公共小工具。

连接参数全部从环境变量读，缺省当成「本机刚装好的 MySQL」：
127.0.0.1:3306 上的 tank/tank，库名 tankbattle。生产部署请一律用环境变量把
口令换掉（systemd unit 里那几行 Environment 就是给它读的）。

连接按线程缓存并自动重连：Flask 是多线程的，PyMySQL 的连接不是线程安全的，
所以每个线程自己留一条；空闲久了 MySQL 会掐掉连接，用之前 ping 一下补回来。
"""

import os
import threading

import pymysql
import pymysql.cursors

DB_HOST = os.environ.get("TANK_DB_HOST", "127.0.0.1")
DB_PORT = int(os.environ.get("TANK_DB_PORT", "3306"))
DB_USER = os.environ.get("TANK_DB_USER", "tank")
DB_PASSWORD = os.environ.get("TANK_DB_PASSWORD", "tank")
DB_NAME = os.environ.get("TANK_DB_NAME", "tankbattle")

_local = threading.local()


def _connect():
    return pymysql.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME,
        charset="utf8mb4",
        autocommit=True,
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=5,
        read_timeout=10,
        write_timeout=10,
    )


def connection():
    """取本线程的连接，必要时重连。"""
    conn = getattr(_local, "conn", None)
    if conn is not None:
        try:
            conn.ping(reconnect=True)
            return conn
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            _local.conn = None
    conn = _connect()
    _local.conn = conn
    return conn


def query(sql, args=None):
    """查多行。"""
    conn = connection()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, args or ())
            return cur.fetchall()
    except Exception:
        _drop()
        raise


def query_one(sql, args=None):
    """查一行（没有就 None）。"""
    rows = query(sql, args)
    return rows[0] if rows else None


def execute(sql, args=None):
    """写一行/多行，返回受影响行数。"""
    conn = connection()
    try:
        with conn.cursor() as cur:
            return cur.execute(sql, args or ())
    except Exception:
        _drop()
        raise


def insert(sql, args=None):
    """写一行并拿回自增主键。"""
    conn = connection()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, args or ())
            return cur.lastrowid
    except Exception:
        _drop()
        raise


def _drop():
    conn = getattr(_local, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
    _local.conn = None


def health():
    """给 /api/health 用的探活：能查通就算好。"""
    try:
        row = query_one("SELECT DATABASE() AS db, NOW() AS now")
        return {"ok": True, "database": row["db"], "serverTime": str(row["now"])}
    except Exception as error:  # noqa: BLE001 - 探活要把任何异常都变成可读结果
        return {"ok": False, "message": str(error)}
