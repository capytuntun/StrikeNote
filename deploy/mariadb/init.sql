-- StrikeNote：建立資料庫與應用程式帳號。
-- 先把 CHANGE_ME 換成長密碼，再以 root 執行： sudo mariadb < deploy/mariadb/init.sql
-- 資料表由 app 啟動時自己建立（server/db.js），這裡只給資料庫與權限。
-- DROP 是給遷移工具 --force（TRUNCATE）用的；不需要可以拿掉。
CREATE DATABASE IF NOT EXISTS strikenote CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'strikenote'@'localhost' IDENTIFIED BY 'CHANGE_ME';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, LOCK TABLES
  ON strikenote.* TO 'strikenote'@'localhost';
FLUSH PRIVILEGES;
