# -*- coding: utf-8 -*-
import os, time, statistics, socket
import pymysql
import pymysql.cursors

def conn():
    return pymysql.connect(host=os.environ.get("TANK_DB_HOST","127.0.0.1"),
        port=int(os.environ.get("TANK_DB_PORT","3306")),
        user=os.environ.get("TANK_DB_USER","tank"),
        password=os.environ.get("TANK_DB_PASSWORD",""),
        database=os.environ.get("TANK_DB_NAME","tankbattle"),
        autocommit=True, cursorclass=pymysql.cursors.DictCursor)

def bench(fn, n=1200):
    out = []
    for _ in range(n):
        t = time.perf_counter(); fn(); out.append((time.perf_counter()-t)*1000)
    return out

def rep(name, xs):
    xs = sorted(xs)
    print("%-34s p50 %6.3f ms   p95 %6.3f ms   p99 %6.3f ms" % (name, statistics.median(xs), xs[int(len(xs)*.95)], xs[int(len(xs)*.99)]))

c = conn(); cur = c.cursor()
rep("1 条语句 SELECT 1", bench(lambda: (cur.execute("SELECT 1"), cur.fetchall())))
def two():
    cur.execute("SELECT 1"); cur.fetchall()
    cur.execute("SELECT 1"); cur.fetchall()
rep("2 条语句（/api/room/input 形状）", bench(two))
c.close()

for host in ("119.29.29.29", "8.8.8.8"):
    try:
        t = time.perf_counter(); s = socket.create_connection((host, 53), timeout=3); s.close()
        print("到 %-14s 的 TCP 连接           %.1f ms" % (host, (time.perf_counter()-t)*1000))
    except Exception as e:
        print("到 %-14s 连接失败: %s" % (host, e))
