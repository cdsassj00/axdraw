# AXPad → axdraw.org 기능 이식 인수인계서 (Handoff Guide)

> **목적**: 연습 프로젝트(`axpad-lab.pages.dev`)에서 실험·검증한 **강의 게시판 & UX 개선 기능** 중, `axdraw.org` 실서비스에 바로 붙일 만한 기능만 깔끔하게 취사선택해 이식하기 위한 문서입니다.
> **참고**: `🔬 X-Ray 학습 패널`과 `/guide` 초보자 안내서는 Cloudflare 학습용 데모 전용이므로 **`axdraw.org` 이식 시 제외**하는 것을 권장합니다.

---

## 1. 실서비스(`axdraw.org`) 이식 추천 기능 목록 (취사선택 가능)

### ✅ ① 화살표/직선 선택 시 커다란 사각 박스 제거 (즉시 반영 강력 추천)
* **문제**: 기존 `axdraw`에서 단일 화살표(`arrow`) 또는 직선(`line`)을 선택하면 사각형처럼 점선+실선 박스 및 8방향 핸들이 표시됨.
* **수정 내용**: Excalidraw처럼 단일 화살표/직선 선택 시 사각 박스를 숨기고 **시작점·끝점·중간점 원형 핸들만 즉시 활성화**.
* **참고 파일**:
  * `axpad/src/scene/interactive.ts` (line 82~89: 단일 `arrow`/`line`의 `drawElementOutline` 스킵)
  * `axpad/src/app.ts` (line 530~555: `singleSelectedLinear` 처리 / line 808~840: 단일 선택 시 `activeLinear` 포인트 드래그 즉시 허용)

### ✅ ② Padlet 스타일 「강의 게시판」 모드 + 캔버스 1:1 매칭
* **기능**:
  * 상단 중앙 플로팅 바에서 **`🎨 판서 캔버스` ↔ `📋 강의 게시판`** 1클릭 전환
  * **Wall(그리드)** / **Shelf(카테고리별 컬럼)** 뷰 전환
  * **1:1 양방향 자동 매칭**: 게시판 전환·생성 시 `[SLUG] 제목` 규칙으로 `axdraw` 캔버스(`app.listBoards`, `app.openBoard`, `app.newBoard`, `app.renameBoard`)도 자동 전환·생성
  * **1클릭 `＋ 카테고리` 추가** (Wall 필터 바 끝 + Shelf 맨 오른쪽 컬럼)
* **참고 파일**:
  * `axpad/src/padlet.ts` (X-Ray 관련 코드 `xrayDrawer`, `addTraces`, `/guide` 링크만 제거하고 이식)
  * `axpad/src/main.ts` (`mountAxPad(app)` 2줄 연결)

### ✅ ③ Google Keep / Padlet 스타일 인라인 포스트잇 작성기 + 링크·파일 업로드
* **기능**:
  * 팝업 모달(드래그 시 닫힘 버그) 대신 게시판 상단 **인라인 확장 포스트잇 카드** (6색 실시간 배경 전환, 바깥 클릭/드래그로 닫히지 않음)
  * **내가 만든 사이트 링크 공유 카드**: URL 입력 시 파비콘 + 도메인 + 새 탭 열기(`↗`) 카드 렌더링
  * **모든 파일 업로드 (R2)**: 이미지 + PDF/PPT/Word/Excel/ZIP/HWPX 드래그 앤 드롭 업로드, PDF `👁️ 보기` + 원본 한글 파일명 `⬇️ 받기` (`Content-Disposition: attachment; filename*=UTF-8''...`)
* **참고 파일**:
  * 프론트: `axpad/src/padlet.ts` (`axp-composer-wrap`, `renderLinkCard`, `renderMedia`)
  * API: `axpad/functions/api/[[path]].js` (`/api/boards`, `/api/board`, `/api/posts`, `/api/upload`, `/api/media/:key`)

### ✅ ④ (선택) 보드 AI 요약·퀴즈 & AI 의미 검색 (Workers AI + AI Gateway + Vectorize)
* **기능**:
  * **✨ AI 요약 / 📝 AI 퀴즈**: 보드 포스트잇 전체를 `@cf/meta/llama-3.3-70b-instruct-fp8-fast`로 요약/퀴즈 생성 (AI Gateway 경유)
  * **🧠 AI 의미 검색**: `@cf/baai/bge-m3` 한국어 임베딩 + Vectorize(`1024 dims, cosine`)로 유사 포스트잇 검색
* **참고 파일**:
  * `axpad/workers/backend/index.js` (`/run`, `/vector/upsert`, `/vector/search`)
  * `axdraw.org`는 이미 Workers 단일 프로젝트이므로 별도 Worker로 쪼개지 않고 기존 `worker/index.js` 안에 라우트와 `[ai]` / `[[vectorize]]` 바인딩만 추가하면 됩니다.

---

## 2. `axdraw.org` D1 스키마 추가분 (기존 테이블과 충돌 없음)

기존 `axdraw-db`에 아래 3개 테이블만 `CREATE TABLE IF NOT EXISTS`로 추가하면 됩니다:

```sql
CREATE TABLE IF NOT EXISTS boards (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  notice TEXT NOT NULL DEFAULT '',
  sections_json TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_slug TEXT NOT NULL DEFAULT 'AX2026',
  section TEXT NOT NULL,
  author TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'yellow',
  media_key TEXT,
  media_type TEXT,
  media_name TEXT,
  media_size INTEGER,
  link_url TEXT,
  pos_x INTEGER NOT NULL DEFAULT 60,
  pos_y INTEGER NOT NULL DEFAULT 60,
  likes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
);
```

---

## 3. 기존 `axdraw` 에이전트에게 넘길 프롬프트 예시

> `C:\Users\value\Desktop\파일럿프로젝트\안티그래비티_클라우드플레어연습\axpad\HANDOFF_TO_AXDRAW.md` 문서를 읽고, 그중 **X-Ray 패널과 /guide는 제외**한 채 아래 기능만 현재 `axdraw` 코드 스타일·다국어(`i18n.ts`)·기존 `worker/index.js` 구조에 맞춰 깔끔하게 이식해 줘:
> 1. 화살표/직선 선택 시 사각 박스 제거
> 2. 강의 게시판 모드(Wall/Shelf, 1:1 캔버스 매칭, 1클릭 카테고리)
> 3. 인라인 포스트잇 작성기 + 사이트 링크 카드 + R2 파일 업로드/다운로드
