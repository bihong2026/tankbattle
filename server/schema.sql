-- 打坦克（tankbattle）后台服务 · 数据库结构
-- 库：tankbattle    字符集：utf8mb4
--
-- 设计要点：
--   * 身份就是一个字符串（username）：登录了 DeepSeek 账号就是账号 UID，
--     没登录就是本机游客号（guest- 开头），都不再另发账号。
--   * 在线状态走「心跳时间戳」，不依赖 Redis；掉线的靠 last_seen 过期来判。
--   * 房间的游戏画面快照由房主权威产生，整段 JSON 存在 rooms.state 里，
--     客人只读不写，所以永远只有一份真值，不会两边跑偏。

CREATE DATABASE IF NOT EXISTS `tankbattle`
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;

USE `tankbattle`;

-- 用户与积分。积分由服务端存，客户端只上报一局结果，由服务端累加。
CREATE TABLE IF NOT EXISTS `users` (
  `username`   VARCHAR(64)  NOT NULL COMMENT '身份串：账号 UID 或 guest- 开头的游客号',
  `nickname`   VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '显示名',
  `score`      INT          NOT NULL DEFAULT 0 COMMENT '累计积分',
  `plays`      INT          NOT NULL DEFAULT 0 COMMENT '总对局数',
  `wins`       INT          NOT NULL DEFAULT 0 COMMENT '胜局数',
  `best_score` INT          NOT NULL DEFAULT 0 COMMENT '单局最高分',
  `kills`      INT          NOT NULL DEFAULT 0 COMMENT '累计击毁',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`username`),
  KEY `idx_score` (`score`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户与积分';

-- 在线状态：心跳每几秒刷一次 last_seen。
CREATE TABLE IF NOT EXISTS `presence` (
  `username`  VARCHAR(64) NOT NULL,
  `nickname`  VARCHAR(64) NOT NULL DEFAULT '',
  `status`    VARCHAR(16) NOT NULL DEFAULT 'idle' COMMENT 'idle / lobby / playing',
  `room_id`   VARCHAR(32) NOT NULL DEFAULT '' COMMENT '在房里就写上房间号',
  `last_seen` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`username`),
  KEY `idx_seen` (`last_seen`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='在线心跳';

-- 邀请：队友邀请（组队）或对战邀请，都是同一条记录。
CREATE TABLE IF NOT EXISTS `invites` (
  `id`         VARCHAR(32)  NOT NULL,
  `from_user`  VARCHAR(64)  NOT NULL,
  `from_name`  VARCHAR(64)  NOT NULL DEFAULT '',
  `to_user`    VARCHAR(64)  NOT NULL,
  `mode`       VARCHAR(16)  NOT NULL DEFAULT 'coop' COMMENT 'coop 组队 / pvp 对战',
  `ai_count`   INT          NOT NULL DEFAULT 12,
  `ai_level`   VARCHAR(16)  NOT NULL DEFAULT 'veteran',
  `status`     VARCHAR(16)  NOT NULL DEFAULT 'pending' COMMENT 'pending / accepted / declined / expired',
  `room_id`    VARCHAR(32)  NOT NULL DEFAULT '',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_to` (`to_user`, `status`),
  KEY `idx_from` (`from_user`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='邀请';

-- 房间：房主权威，state 是整段游戏快照 JSON。
CREATE TABLE IF NOT EXISTS `rooms` (
  `id`         VARCHAR(32)  NOT NULL,
  `host`       VARCHAR(64)  NOT NULL,
  `mode`       VARCHAR(16)  NOT NULL DEFAULT 'coop' COMMENT 'coop 组队打NPC / pvp 对战',
  `ai_count`   INT          NOT NULL DEFAULT 12,
  `ai_level`   VARCHAR(16)  NOT NULL DEFAULT 'veteran',
  `status`     VARCHAR(16)  NOT NULL DEFAULT 'lobby' COMMENT 'lobby / playing / over',
  `state`      LONGTEXT     NULL COMMENT '房主发布的画面快照 JSON',
  `state_seq`  INT          NOT NULL DEFAULT 0,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='房间';

-- 房间成员：team 是 A / B（组队模式两人同在 A；对战模式一人 A 一人 B）。
CREATE TABLE IF NOT EXISTS `room_members` (
  `room_id`   VARCHAR(32) NOT NULL,
  `username`  VARCHAR(64) NOT NULL,
  `nickname`  VARCHAR(64) NOT NULL DEFAULT '',
  `team`      VARCHAR(4)  NOT NULL DEFAULT 'A',
  `seat`      INT         NOT NULL DEFAULT 0 COMMENT '0 房主 / 1 客人',
  `ready`     TINYINT     NOT NULL DEFAULT 0,
  `joined_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`room_id`, `username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='房间成员';

-- 客人上传的操作（方向 + 开火）。房主每帧读一次，取最新即可。
CREATE TABLE IF NOT EXISTS `room_inputs` (
  `room_id`    VARCHAR(32)  NOT NULL,
  `seat`       INT          NOT NULL,
  `username`   VARCHAR(64)  NOT NULL,
  `dirs`       VARCHAR(16)  NOT NULL DEFAULT '',
  `fire`       TINYINT      NOT NULL DEFAULT 0,
  `seq`        BIGINT       NOT NULL DEFAULT 0,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`room_id`, `seat`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='房间操作输入';

-- 对局与个人战绩明细。
CREATE TABLE IF NOT EXISTS `matches` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT,
  `room_id`    VARCHAR(32)  NOT NULL DEFAULT '',
  `mode`       VARCHAR(16)  NOT NULL DEFAULT 'solo',
  `winner`     VARCHAR(64)  NOT NULL DEFAULT '',
  `outcome`    VARCHAR(16)  NOT NULL DEFAULT 'over',
  `detail`     VARCHAR(512) NOT NULL DEFAULT '',
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='对局';

CREATE TABLE IF NOT EXISTS `match_players` (
  `match_id` BIGINT      NOT NULL,
  `username` VARCHAR(64) NOT NULL,
  `team`     VARCHAR(4)  NOT NULL DEFAULT 'A',
  `score`    INT         NOT NULL DEFAULT 0,
  `kills`    INT         NOT NULL DEFAULT 0,
  `delta`    INT         NOT NULL DEFAULT 0 COMMENT '本局给用户加的积分',
  `outcome`  VARCHAR(16) NOT NULL DEFAULT 'over',
  PRIMARY KEY (`match_id`, `username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='对局参与者';
