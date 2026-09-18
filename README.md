# StrikeNote
>[!note]
>有鑑於HackMD越來越爛，故自行用AI寫了一個StrikeNote，以符合自己的筆記需求，這個筆記軟體是以Markdown為基礎的筆記，同時支援生成OSCP、OSEP、LPT\CPENT跟Virtual Hacking Lab的筆記模板，並且支援生成資安院攻防演練模式的報告


裝好 Node.js 後，在資料夾中執行：
```
node server/server.js
```

預設網址為 http://localhost:8080
需要一個 MariaDB（連線資訊用 `DB_*` 環境變數指定，見 `deploy/env.example`）。首次啟動會建立 `admin` 帳號並把隨機密碼印在終端機（或用 `ADMIN_PASSWORD` 指定），首次登入時要求更改。部署到 Raspberry Pi、從舊版 SQLite 搬資料：見 `deploy/README.md`

## 系統畫面
![interface](docs/interface.png)

可以使用類似Hackmd的方式編輯筆記，左邊編輯的內容可以即時顯示在右邊的預覽
![interface](docs/mdeditor.png)

## 筆記模式
主要有三種筆記模式，可以對應到不同的功能
- 一般筆記模式
- 證照範本
- 資安院報告模式
### 一般筆記模式
具備一般md的基礎語法與功能，圖片也是直接拖拉上去就可以顯示出來，其中callout採用的是github的書寫語法。
```
> [!NOTE]  
> Highlights information that users should take into account, even when skimming.

> [!TIP]
> Optional information to help a user be more successful.

> [!IMPORTANT]  
> Crucial information necessary for users to succeed.

> [!WARNING]  
> Critical content demanding immediate user attention due to potential risks.

> [!CAUTION]
> Negative potential consequences of an action.
```
![callout](docs/callout.png)

除了 GitHub 的 `> [!NOTE]` 寫法，也支援 CodiMD / HackMD 的 `:::` 容器：`:::info … :::` 會產生和 `> [!NOTE]` 完全一樣的提示框。對應關係：`info→note`、`success→tip`、`danger→caution`、`warning→warning`（`note/tip/important/warning/caution` 也可直接寫在 `:::` 後）。可加標題如 `:::info 重點`；編輯器輸入 `/info`、`/success`、`/danger` 可快速插入。

程式碼區塊只依你標明的語言上色（例如 ```` ```bash= ````，`=` 表示顯示行號，`=10` 可指定起始行號）；沒標語言就是純文字，不會自動猜語言。工具列的「▤ Code」、`/code` 與 ``` 後的語言自動完成都預設帶 `=`。

也支援 CodiMD / HackMD 的 `[toc]`：獨立一行寫上 `[toc]`，預覽就會在該處依筆記裡的 H1～H3 標題自動產生可點擊的目錄（編輯器裡輸入 `/toc` 也可插入）。匯出 PDF 時仍使用封面後方附頁碼的目錄頁，內文中的 `[toc]` 不會重複輸出。

### Blog
打開筆記後，左上角 分割／編輯／預覽 旁邊的「Blog」：切過去整個畫面就是排版好的頁面，像 Notion／Medium 一樣點哪一段就直接改那一段。語法跟一般筆記完全一樣（`#` 標題、`-` 清單、```` ``` ```` 程式碼、`/` 指令、`[[` 筆記連結），內容也仍然是 Markdown，所以 PDF 匯出、搜尋、版本歷史、共同編輯都照常運作。段落最後連按兩次 Enter 開新段落，在空白的段落上繼續按 Enter 會一直往下留出空行（原始碼裡是一行 `&nbsp;`，空段落上按 Backspace 拿掉），Esc 結束編輯；想看原始碼時切到上方的「分割」。貼上或拖進來的圖片會直接顯示成圖片，不會留一行語法。反白一段文字會浮出格式工具列，可以直接把它改成粗體、斜體、刪除線、行內程式碼、連結，或整行改成標題、引言、清單、程式碼區塊；輸入 `/code` 也能插入一個程式碼區塊。表格可以像 Notion 一樣拉欄寬——滑到欄與欄的邊界會出現一條線，拉它就能調整欄寬，欄寬存在筆記裡，預覽、PDF、電子書都會照著顯示。

### 檔案、PDF 與網址預覽
- 圖片、PDF 和任何檔案都可以貼上、拖進編輯器（或 Blog 頁面），也可以按工具列的「檔案」或輸入 `/file` 挑檔案。圖片直接顯示；PDF 可以直接預覽 `![名稱](pdf:…)`，或只顯示成檔案連結 `[名稱](pdf:…)`；其他檔案是一個下載連結 `[名稱](file:…)`。
- 滑鼠移到 PDF 上會出現「檔案｜預覽」切換鈕；移到獨佔一行的網址上會出現「連結｜預覽卡片」。
- 網址預覽卡片寫成 `{%preview https://… %}`（或輸入 `/preview`），會顯示網頁標題、摘要與縮圖；這些資訊由伺服器去抓，主機不能對外連線時設 `LINK_PREVIEW=0`。
- 左下角「檔案管理」列出所有上傳過的檔案、各自用在哪些筆記，也可以直接上傳。

### 備份與還原
右上角帳號選單 → 「備份與還原」。「下載備份 zip」會把你所有的筆記（每篇一個 `.md`，照資料夾放好）、上傳過的圖片與檔案、版本歷史、分享設定、電子書與垃圾桶裡的筆記打包成一個 zip；管理員可以改選「整個站台」，連所有使用者帳號（含密碼雜湊）與註冊設定一起帶走，之後在一台全新的機器上還原就能整站復原。還原時上傳同一個 zip：會先顯示這份備份的內容再由你確認；缺的會補回來、已經有的預設不動，勾「覆蓋」才會用備份裡的內容取代現有筆記（覆蓋前會先留一份版本）。

### 排序
側邊欄搜尋框旁、首頁清單右上角的「排序」可以選手動排序、名稱、建立時間、最近更新，兩邊共用同一套。手動排序時直接拖拉筆記或資料夾就能調整順序，順序存在伺服器上，換電腦也一樣。左邊的清單和首頁是同一套拖拉：可以把筆記從側邊欄直接拖到首頁的資料夾方框裡，也可以反過來從首頁拖回側邊欄的資料夾。

### 證照範本
目前既有的模板有OSCP、OSEP、LPT\CPENT、Vurtual Hacking Lab
![callout](docs/report.png)

點擊後可以自動生成相對應的模板，讓打OSCP時只需要把相對應的東西填進去就可以，點擊右上方PDF按鈕可以下載成PDF。

