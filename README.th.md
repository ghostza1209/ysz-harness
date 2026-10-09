<p align="center">
  <img src="web/public/logo.svg" width="96" alt="ysz-harness logo" />
</p>

<h1 align="center">ysz-harness</h1>

<p align="center"><a href="README.md">English</a> · <b>ไทย</b></p>

**ysz** หยิบ Ready Ticket จากคิว Beads ของแต่ละ Project มาให้ Claude agent ทำใน Docker sandbox แยกกัน ให้ agent ตัวที่สองรีวิวและแก้งาน แล้วเปิด pull request รอคุณรีวิว ไม่ merge เองเด็ดขาด ความหมายของศัพท์ดูได้ที่ [GLOSSARY.md](GLOSSARY.md)

## Run ทำงานอย่างไร

1. ติด label `ready-for-agent` ให้ bead ที่เปิดอยู่ใน repo ของ Project
2. เมื่อมี slot ว่าง (สูงสุด 1 Run ต่อ Project) ysz จะ claim Ticket และ clone repo ไว้บน branch `agent/<ticket-id>`
3. **Implement agent** ทำ Ticket ใน sandbox จากนั้น **Review agent** รีวิวและแก้งาน ถ้า Attempt แรกล้มจะลองใหม่อีกครั้งเดียว
4. ฝั่ง host push branch แล้วเปิด PR เข้า `baseBranch` ของ Project ตัว bead จะได้คอมเมนต์ลิงก์ PR และ label `in-review`
5. ถ้า agent ต้องการข้อมูลเพิ่ม bead จะถูกส่งคืนพร้อมคอมเมนต์คำถามและ label `needs-info`

## สิ่งที่ต้องมี

- Node.js 22 ขึ้นไป และ npm
- Docker (เปิดไว้)
- [`bd`](https://github.com/gastownhall/beads) (Beads) ตั้งค่าไว้ใน repo ของแต่ละ Project
- [`gh`](https://cli.github.com/) login ไว้ทุกบัญชีที่ใช้เปิด PR (`gh auth status`)
- [`claude`](https://docs.claude.com/en/docs/claude-code) CLI บนเครื่อง host (ใช้เขียนเนื้อหา PR)

## ติดตั้ง

```bash
npm install
npm run images                     # build sandbox image จาก images/*.Dockerfile
claude setup-token                 # คัดลอก token ที่แสดงออกมา
echo 'CLAUDE_CODE_OAUTH_TOKEN=<token>' > .env
```

จากนั้นเพิ่มหรือแก้ Project ใน [`src/projects.ts`](src/projects.ts): path ของ repo, base branch, sandbox image, ไฟล์ที่ต้องคัดลอกเข้า worktree (เช่น `.env`), คำสั่ง install และ check hint Project ที่ไม่มี `image` จะไม่ถูกหยิบงาน

## เริ่มใช้งาน

```bash
npm start          # build Dashboard แล้วเริ่ม ysz (PORT ค่าเริ่มต้น 4000)
```

เปิด URL ที่แสดงใน terminal (`http://localhost:4000/?token=…`) token เก็บอยู่ที่ `data/dashboard-token` ลบไฟล์นี้ทิ้งเพื่อสร้าง token ใหม่

## การใช้งานประจำวัน

| ต้องการ | ทำแบบนี้ |
| --- | --- |
| ส่ง Ticket เข้าคิว | `bd update <id> --add-label ready-for-agent` ใน repo ของ Project |
| กัน Ticket ไม่ให้ ysz หยิบ | `bd update <id> --add-label orchestrator:skip` |
| หยุดหยิบงานจาก Project | คลิกปุ่มชื่อ Project ด้านบนของ Dashboard (คลิกอีกครั้งเพื่อทำต่อ) |
| หยุด Run ที่กำลังทำ | กด **Kill** บนการ์ด Ticket จะได้ label `orchestrator:skip` |
| ทำต่อ Run ที่ค้างที่ host step | กด **Retry host step** บนการ์ด |
| ดูว่า Run ทำอะไรไปบ้าง | กด **Log** ในรายการ History |

เมื่อ Run จบที่สถานะ `In review` ให้รีวิวและ merge PR เอง แล้วปิด bead

## พัฒนา

```bash
npm test           # unit tests
npm run typecheck
```

โค้ดอยู่ใน `src/` (server, แกน ysz, sandbox, host steps) และ `web/` (Dashboard) การตัดสินใจด้านดีไซน์อยู่ใน [`docs/adr`](docs/adr)
