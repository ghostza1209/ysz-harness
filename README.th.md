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
   Ticket ที่ blocker ตัวเดียวที่ยังไม่ปิดอยู่ใน `In review` ไม่ต้องรอ merge: Run จะ clone จาก branch `agent/<id>` ของ blocker แล้วเปิด stacked PR ต่อบน branch นั้น (`gh stack link` ต้องติดตั้ง extension `gh-stack`) ดู [ADR 0005](docs/adr/0005-in-review-unblocks-dependents-as-stacked-prs.md)
   Ticket ที่ epic แม่ติด label `epic-branch` จะ clone และเปิด PR เข้า `epic/<epic-id>` (ตาม `epicBranchPrefix` ของ Project) แทน ทำให้ `baseBranch` ได้ PR เดียวต่อ epic ดู [ADR 0006](docs/adr/0006-epic-branch-collects-an-epics-prs.md)
5. ถ้า agent ต้องการข้อมูลเพิ่ม bead จะถูกส่งคืนพร้อมคอมเมนต์คำถามและ label `needs-info`

epic ที่ติด label `ready-for-agent` และยังไม่มี child เลยเรียกว่า **Spec** Run ของ Spec ไม่มี Review agent และไม่เปิด PR: breakdown agent จะแตก Spec เป็น child Ticket แล้ว ysz สร้างไว้ใต้ epic โดยติด `ready-for-agent` ให้เลย Ticket เหล่านี้จะเข้าคิวใน poll ถัดไป ดู [ADR 0007](docs/adr/0007-ysz-breaks-a-childless-spec-down.md)

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
| ให้ ysz แตก Spec เป็น Ticket | `bd update <epic-id> --add-label ready-for-agent` บน epic ที่ยังไม่มี child เมื่อ Spec เขียนเสร็จแล้ว |
| รวม PR ของ epic ไว้ใน branch เดียว | `bd update <epic-id> --add-label epic-branch` แล้วเปิด PR `epic/<epic-id>` → `baseBranch` เองเมื่อ merge child ครบ |
| หยุดหยิบงานจาก Project | คลิกปุ่มชื่อ Project ด้านบนของ Dashboard (คลิกอีกครั้งเพื่อทำต่อ) |
| หยุด Run ที่กำลังทำ | กด **Kill** บนการ์ด Ticket จะได้ label `orchestrator:skip` |
| ทำต่อ Run ที่ค้างที่ host step | กด **Retry host step** บนการ์ด |
| ส่ง Ticket ของ Run ที่ล้มเหลวกลับเข้าคิว Ready | กด **ลองใหม่** ในแถวของมันใน History |
| ดูว่า Run ทำอะไรไปบ้าง | กด **Log** ในรายการ History |

เมื่อ Run จบที่สถานะ `In review` ให้รีวิวและ merge PR เอง ysz จะปิด bead ให้เมื่อเห็นว่า merge แล้ว ถ้า stack ตามหลัง `baseBranch` ให้กด **Rebase stack** ที่หน้า PR

## พัฒนา

```bash
npm test           # unit tests
npm run test:contract  # the Beads gateway against the real bd
npm run typecheck
```

โค้ดอยู่ใน `src/` (server, แกน ysz, sandbox, host steps) และ `web/` (Dashboard) การตัดสินใจด้านดีไซน์อยู่ใน [`docs/adr`](docs/adr)
