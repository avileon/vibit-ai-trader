# VIBIT AI Trader

מערכת לניתוח מניות אמריקאיות ולמסחר **מדומה בלבד** (Alpaca Paper Trading), עם הון בסיס של $1,000.

> ⚠️ זה לא ייעוץ השקעות. היעד של $100 בחודש הוא השערה לבדיקה, לא תחזית. תוצאה חיובית ב-Paper לא מבטיחה רווח בכסף אמיתי.

- ארכיטקטורה, סיכונים ותוכנית: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- גרסה נוכחית: **שלב ג** (חיבור Alpaca Paper — קריאה וסנכרון בלבד)

---

## מה עובד עכשיו ומה לא

| רכיב | מצב |
|---|---|
| התחברות (סשן מאובטח, נעילה אחרי 5 ניסיונות, Rate Limit) | ✅ עובד |
| MySQL + מיגרציות + Audit Log | ✅ עובד |
| Dashboard, תיק, הוראות — **עם נתוני DEMO בדויים** (מסומנים בסגול) | ✅ עובד |
| Worker שרץ ברקע 24/7, עולה תמיד במצב בטוח (SAFE) | ✅ עובד (heartbeat בלבד, לא סוחר) |
| Kill Switch + שחרור עם אישור (חוזר ל-SAFE בלבד) | ✅ עובד |
| חסימת Live: השרת לא עולה אם `TRADING_MODE≠paper` או כתובת שאינה Paper; מפתחות `AK…` נדחים | ✅ עובד + בדיקות |
| שמירת מפתחות API מוצפנים (AES-256-GCM), לעולם לא חוזרים לדפדפן | ✅ עובד |
| תצוגת ש״ח לפי שער ידני (מידע בלבד) | ✅ עובד |
| מרכז למידה (מילון מונחים) | ✅ עובד |
| חיבור Alpaca Paper: חשבון, פוזיציות, הוראות (כולל רגלי Bracket), שעון בורסה, היסטוריית שווי, SPY לבנצ׳מרק — סנכרון כל דקה, קריאה בלבד | ✅ עובד + בדיקות (Mock Broker) |
| אימות כפול ל-Paper: כתובת + מפתח PK + מספר חשבון PA… | ✅ עובד |
| שעות מסחר | ✅ לפי שעון Alpaca; הערכה מסומנת רק כשאין חיבור |
| אסטרטגיה, מנוע סיכון, שליחת פקודות | ⏳ שלב ד — **כרגע אי אפשר להפעיל את הבוט** (ההפעלה נחסמת עם הסבר) |
| AI Analyst (Claude) | ⏳ שלב ה |
| Strategy Lab, Backtest, דוחות | ⏳ שלב ו |
| התראות Email/WhatsApp | ⏳ שלב ז — לא נשלחת שום הודעה כרגע |

---

## התקנה ב-Windows (הדרך הקלה)

1. ודא ש-**Docker Desktop** פתוח ומציג "Engine running".
2. פתח את תיקיית הפרויקט בסייר הקבצים (התיקייה שבה נמצאים `docker-compose.yml` ו-`README.md`).
3. בשורת הכתובת של הסייר הקלד `powershell` ולחץ Enter — PowerShell ייפתח **בתוך** התיקייה.
4. הרץ:
```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```
הסקריפט: יוצר `.env` עם סודות אקראיים → בונה ומרים את הקונטיינרים → מחכה לבריאות → מבקש אימייל וסיסמה למנהל → טוען DEMO → פותח את הדפדפן.

בדיקת בריאות בהמשך: `powershell -ExecutionPolicy Bypass -File .\scripts\healthcheck.ps1`

> אל תדביק ב-PowerShell שורות עם הערות בעברית (`# ...`) — הקונסולה משבשת אותן.

---

## התקנה מקומית עם Docker (Linux / Mac)

דרישות: Docker Desktop (או Docker Engine + Compose v2), Git.

```bash
git clone <your-repo-url> vibit-ai-trader
cd vibit-ai-trader
cp .env.example .env
```

מלא ב-`.env` שלושה ערכים (מייצרים כך):
```bash
openssl rand -base64 32   # → MASTER_KEY
openssl rand -hex 24      # → MYSQL_ROOT_PASSWORD
openssl rand -hex 24      # → MYSQL_PASSWORD
```

הרמה:
```bash
docker compose up -d --build
docker compose ps                     # כל השירותים צריכים להיות Up / healthy
```

יצירת משתמש מנהל (הסיסמה תתבקש בהקלדה — לא נשמרת בהיסטוריית ה-shell):
```bash
docker compose exec -it api node dist/scripts/createAdmin.js --email you@example.com --name "Avi"
```

טעינת נתוני DEMO (אופציונלי, כדי לראות את הממשק):
```bash
docker compose exec api node dist/db/seedDemo.js
```

פתח: http://localhost:3000

בדיקת בריאות:
```bash
./scripts/healthcheck.sh            # OK = DB תקין, Paper, Worker חי
docker compose logs -f worker       # צריך לראות: started ... in SAFE mode
```

---

## הרצה ללא Docker (פיתוח)

דרישות: Node.js 22, MySQL 8.

```bash
npm install
mysql -uroot -p -e "CREATE DATABASE vibit CHARACTER SET utf8mb4; CREATE USER 'vibit'@'localhost' IDENTIFIED BY 'pw'; GRANT ALL ON vibit.* TO 'vibit'@'localhost';"

export DATABASE_URL=mysql://vibit:pw@127.0.0.1:3306/vibit
export TRADING_MODE=paper
export MASTER_KEY=$(openssl rand -base64 32)   # שמור את הערך! בלעדיו מפתחות שמורים לא ייפתחו

npm run migrate -w apps/api
npm run create-admin -w apps/api -- --email you@example.com --name Avi
npm run seed:demo -w apps/api

# שלושה טרמינלים:
npm run dev -w apps/api          # API על 4000
npm run dev:worker -w apps/api   # מנוע ברקע
npm run dev -w apps/web          # ממשק על 3000
```

---

## בדיקות

```bash
# Unit (ללא DB): paper guard, הצפנה, סיסמאות, שעות מסחר, ספי סיכון
npm test

# Integration (DB אמיתי — מוחק את מסד הבדיקה!)
TEST_DATABASE_URL=mysql://root:pw@127.0.0.1:3306/vibit_test npm test

# E2E בדפדפן (המערכת צריכה לרוץ על 3000)
npx playwright install chromium   # פעם אחת
E2E_EMAIL=you@example.com E2E_PASSWORD=... npm run test:e2e
```

מה נבדק: חסימת Live (URL, mode, מפתח AK), CSRF, סיסמה שגויה, עוגייה httpOnly+Strict, DEMO מסומן, Kill Switch → HALTED → SAFE, חסימת ACTIVE עם סיבות, מפתחות מוצפנים ולא דולפים ל-API/Audit, Logout מבטל סשן, זמנים ב-UTC, אין גלילה אופקית בנייד.

### תנאי קבלה — שלב ב
- [ ] `docker compose up -d --build` → כל השירותים healthy
- [ ] `./scripts/healthcheck.sh` מחזיר OK
- [ ] התחברות עובדת; סיסמה שגויה נדחית
- [ ] Dashboard מציג נתוני DEMO עם תג סגול
- [ ] Kill Switch מפעיל HALTED; שחרור דורש "אני מאשר" ומחזיר ל-SAFE
- [ ] "בקש הפעלה" נחסם עם רשימת סיבות
- [ ] `docker compose restart worker` → ביומן: "המנוע הופעל מחדש (מצב בטוח)"
- [ ] `TRADING_MODE=live` ב-.env → api ו-worker לא עולים

---

## הכנה לשלב ג: פתיחת חשבון Alpaca Paper

1. היכנס ל-https://alpaca.markets ולחץ Sign Up. אפשר להירשם עם אימייל בלבד — **חשבון Paper לא דורש הפקדה או אימות זהות** לחשבון אמיתי. אל תמלא פרטי חשבון אמיתי.
2. בדשבורד, ודא שבפינה מופיע **Paper Trading** (ולא Live).
3. חשבון Paper נפתח עם $100,000 כברירת מחדל. צור/אפס חשבון Paper עם **$1,000** (בתפריט החשבונות). גם אם לא — המערכת מחשבת סיכון לפי $1,000 בלבד.
4. בעמוד הבית של Paper → **API Keys** → Generate. תקבל Key ID (מתחיל ב-`PK`) ו-Secret (מוצג פעם אחת).
5. **אל תדביק את המפתחות בצ׳אט.** הזן אותם רק בממשק: הגדרות → מפתחות API (נשמרים מוצפנים), או ב-`.env` בשרת.
6. אחרי איפוס חשבון Paper — צריך ליצור מפתחות חדשים.

הערות חשובות לחשבון קטן (פירוט ב-ARCHITECTURE §5):
- חשבון Paper מקבל נתוני IEX בלבד (בורסה אחת) — מחירים ו-Spread עלולים לסטות.
- מניות חלקיות ב-Alpaca: רק פקודות DAY וללא Bracket ⇒ בגרסה 1 נסחר במניות שלמות בלבד, ועסקה שיוצאת פחות ממניה אחת תידחה.

---

## פריסה לשרת (VPS Linux)

UPRESS: מתאים לאתרים; ה-Worker צריך תהליך שרץ 24/7, לכן מומלץ VPS (למשל DigitalOcean/Hetzner, 2GB RAM).

```bash
# על שרת Ubuntu נקי
curl -fsSL https://get.docker.com | sh
git clone <repo> /opt/vibit-ai-trader && cd /opt/vibit-ai-trader
cp .env.example .env && nano .env        # COOKIE_SECURE=true, WEB_BIND=127.0.0.1
docker compose up -d --build
docker compose exec -it api node dist/scripts/createAdmin.js --email you@example.com
```

HTTPS עם Caddy (תעודה אוטומטית):
```bash
apt install -y caddy
cat >/etc/caddy/Caddyfile <<'EOF'
trader.yourdomain.com {
  reverse_proxy 127.0.0.1:3000
}
EOF
systemctl reload caddy
```

גיבוי יומי + ניטור:
```bash
crontab -e
15 3 * * * /opt/vibit-ai-trader/scripts/backup.sh >> /var/log/vibit-backup.log 2>&1
*/5 * * * * /opt/vibit-ai-trader/scripts/healthcheck.sh https://trader.yourdomain.com >/dev/null || echo "VIBIT DOWN" | logger
```
שמור את `MASTER_KEY` במקום נפרד מהגיבויים (מנהל סיסמאות).

חומת אש: פתח רק 22, 80, 443 (`ufw allow OpenSSH; ufw allow 80,443/tcp; ufw enable`). MySQL לא חשוף החוצה.

---

## אבטחה — מה כבר מיושם
- סשן: טוקן אקראי 256bit, נשמר כ-SHA-256 ב-DB, עוגייה `httpOnly` + `SameSite=Strict` (+`Secure` בפרודקשן), תפוגה 12 שעות.
- סיסמאות: scrypt; נעילה ל-15 דק׳ אחרי 5 כישלונות; Rate Limit 5/דקה על התחברות, 120/דקה כללי.
- CSRF: כל בקשה משנה מחייבת header `x-vibit-csrf` (לא ניתן לשליחה מאתר זר בלי CORS, שאינו מופעל).
- קלט: Zod בכל endpoint. Body מוגבל ל-64KB.
- לוגים: עוגיות, סיסמאות וערכי מפתחות מוסתרים; Audit מסנן שדות שנראים כמו סוד.
- קונטיינרים רצים כמשתמש לא-root; MySQL לא מפורסם החוצה.

## מבנה תיקיות
```
apps/api/            Fastify + Worker (TypeScript)
  src/config.ts        טעינת ENV + paper guard
  src/lib/paperGuard.ts  חסימת Live
  src/lib/crypto.ts      הצפנה/סיסמאות
  src/riskConfig.ts      ספי סיכון
  src/db/migrations/     SQL
  src/routes/            REST
  src/worker.ts          מנוע ברקע
  test/                  unit + integration
apps/web/            Next.js RTL
e2e/                 Playwright smoke
docs/ARCHITECTURE.md
scripts/             backup, healthcheck
```
