# axdraw

손그림 스타일 화이트보드. Excalidraw처럼 쓰되, **대충 그린 도형을 자동으로 반듯하게 잡아주는 기능**이 들어 있습니다.
강의 중에 원이나 박스를 슥슥 그리면 곧바로 각 잡힌 도형으로 바뀝니다.

의존성 없는 TypeScript + Canvas 구현입니다. 서버도, 계정도, 빌드 후 런타임 패키지도 필요 없습니다.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # dist/ 에 정적 파일 생성
npm run test:e2e # 브라우저 자동화 테스트 31개
```

---

## 도형 자동 인식 (Shape assist)

오른쪽 위 지팡이 버튼(기본 켜짐)이 이 기능입니다. 그리기(P) 도구로 쓱 그린 뒤 손을 떼면 분류합니다.

| 그린 것 | 결과 |
| --- | --- |
| 대충 그린 네모 | 사각형 (기울여 그리면 **기울어진 각도까지 유지**) |
| 대충 그린 동그라미 | 타원 / 원 |
| 마름모 | 마름모 |
| 삼각형 | 삼각형(닫힌 선) |
| 직선 | 직선 |
| 직선 + 끝에 화살촉 | 화살표 |
| 낙서 | 그대로 손그림 유지 |

동작 방식은 이렇습니다.

1. 스트로크를 균등 간격으로 재샘플링하고 Ramer–Douglas–Peucker로 단순화합니다.
2. 시작점과 끝점이 충분히 가까우면 닫힌 도형으로 봅니다.
3. 닫힌 도형은 두 가지 기준 프레임에서 후보를 평가합니다.
   - **최소 넓이 사각형** — 사각형(기울어진 것 포함)에 맞는 프레임
   - **꼭짓점 정렬 프레임** — 마름모에 맞는 프레임 (마름모의 최소 넓이 사각형은 *변*에 정렬되어서, 이것만 쓰면 기울어진 사각형과 구분이 안 됩니다)
4. 각 프레임에서 사각형·타원·마름모 잔차를 계산하고, 채움 비율(면적 / 프레임 면적)로 걸러낸 뒤 오차가 가장 작은 후보를 고릅니다.
5. 어느 것도 확실하지 않으면 **손그림 그대로 둡니다.** 판정은 보수적으로 되어 있어서, 애매하면 바꾸지 않습니다.

가로세로가 12% 이내로 비슷하면 정사각형·정원으로 맞추고, 기울기가 8° 이내면 0°로 정렬합니다.

---

## 기능

**도구** — 선택, 손(패닝), 사각형, 마름모, 타원, 화살표, 선, 그리기, 텍스트, 이미지, 지우개, 프레임, 레이저 포인터.
`Q`로 도구 고정(연속 그리기)을 켤 수 있습니다.

**스타일** — 획/배경 색상(빠른 팔레트 + 130색 피커 + 커스텀 HEX), 채움(빗금·교차빗금·단색·지그재그), 획 굵기 3단계, 실선/파선/점선, 손그림 거칠기 3단계(architect/artist/cartoonist), 모서리(각짐/둥글게), 투명도, 화살촉 7종, 글꼴 3종·크기 4단계·정렬.

**편집** — 다중 선택(마퀴·Shift 클릭), 이동, 8방향 리사이즈, 회전, 그룹/그룹해제, 앞뒤 순서, 정렬 6종 + 균등 분배, 좌우/상하 뒤집기, 잠금, 복제(Ctrl+D 또는 Alt+드래그), 무제한 실행취소/재실행.

**연결** — 화살표를 도형에 붙이면 도형을 옮기거나 크기를 바꿔도 화살표가 계속 따라옵니다. 도형 안을 더블클릭하면 도형에 라벨이 붙고, 도형 크기에 맞춰 자동 줄바꿈·가운데 정렬됩니다(한글 줄바꿈 지원).

**정렬 보조** — 다른 객체의 모서리·중심선에 자동 스냅(이동·리사이즈 모두), 스냅 가이드 표시, 격자 모드, Shift로 15° 각도 스냅.

**텍스트** — 캔버스 위에 겹쳐 놓은 textarea로 편집하므로 한글 IME 조합이 정상 동작합니다. Enter는 줄바꿈, Ctrl+Enter 또는 Escape로 완료.

**캔버스** — 무한 스크롤, 0.1×~30× 확대, 마우스 휠·트랙패드·핀치 줌, 다크/라이트 테마, 캔버스 배경색, 화면 맞춤/선택 영역 맞춤, 통계 패널(선택한 도형의 X·Y·W·H·각도 직접 입력 가능).

**저장과 내보내기** — 로컬 자동 저장(새로고침해도 유지), `.axdraw` 파일 저장/열기, PNG·SVG 내보내기(배율·배경·선택 영역만 옵션), PNG 클립보드 복사, 이미지 붙여넣기·드래그 앤 드롭. **Excalidraw의 `.excalidraw` 파일과 클립보드 데이터도 그대로 열립니다.**

**입력** — 마우스, 펜(필압 반영), 터치(그리기 + 두 손가락 확대/이동) 모두 지원.

---

## 단축키

메뉴 → 키보드 단축키 또는 `?` 키로 전체 목록을 볼 수 있습니다. 자주 쓰는 것만:

| | |
| --- | --- |
| 도구 | `V` 선택 · `R` 사각형 · `D` 마름모 · `O` 타원 · `A` 화살표 · `L` 선 · `P` 그리기 · `T` 텍스트 · `E` 지우개 · `F` 프레임 · `K` 레이저 · `H`/`Space` 이동 |
| 편집 | `Ctrl+Z` / `Ctrl+Shift+Z` · `Ctrl+D` 복제 · `Ctrl+G` 그룹 · `Ctrl+]` / `Ctrl+[` 순서 · `Delete` 삭제 · `Enter` 텍스트 편집 |
| 화면 | `Ctrl+0` 100% · `Shift+1` 전체 맞춤 · `Shift+2` 선택 맞춤 · `Ctrl+'` 격자 |
| 파일 | `Ctrl+S` 저장 · `Ctrl+O` 열기 · `Ctrl+E` 이미지 내보내기 |
| 그리는 중 | `Shift` 정사각형/정원·15° 스냅 · `Alt` 중심에서 그리기 · 클릭 반복 후 `Enter` 다중 꺾은선 |

---

## 구조

```
src/
  rough/          손그림 기하 생성기 (rough.js 스타일: 선·곡선·타원·빗금 채우기)
                  좌표 op 목록만 만들고 캔버스는 건드리지 않음 → 캔버스와 SVG가 같은 결과
  element/        요소 모델: 생성·경계·히트테스트·리사이즈·바인딩·텍스트·스냅·도형 인식
  scene/          정적/인터랙티브 캔버스 렌더러, 내보내기, 저장, 이미지 캐시
  ui/             툴바·스타일 패널·메뉴·다이얼로그·텍스트 에디터 (프레임워크 없음)
  app.ts          에디터 본체: 상태, 포인터 상태 기계, 키보드, 공개 API
tests/e2e.mjs     Playwright 브라우저 테스트
public/fonts/     번들된 손글씨 웹폰트 (Caveat + Gaegu, OFL)
```

성능을 위해 두 가지를 캐시합니다. 요소별 손그림 기하는 `version` 단위로 캐시되어 화면 이동·확대 시 재생성되지 않고, 다크 모드는 스트로크마다 필터를 거는 대신 프레임당 한 번만 합성합니다.

손글씨 느낌은 **Caveat**(라틴)과 **Gaegu**(한글)를 저장소에 함께 넣어서 어느 환경에서든 동일하게 보입니다. 두 폰트 모두 SIL Open Font License 1.1이며 `public/fonts/LICENSE-fonts.txt`에 명시했습니다. 유니코드 범위별로 잘려 있어 실제로는 쓰는 글자에 해당하는 몇 KB만 내려받습니다.

---

## 배포

정적 파일이라 아무 곳에나 올리면 됩니다.

```bash
npm run build              # dist/
VITE_BASE=/axdraw/ npm run build   # 하위 경로로 서비스할 때
```

`.github/workflows/deploy.yml`에 GitHub Pages 배포 워크플로가 들어 있습니다. **처음 한 번은 저장소 Settings → Pages에서 Source를 "GitHub Actions"로 바꿔야 합니다.** 이후로는 기본 브랜치에 푸시할 때마다 자동 배포됩니다.

이 한 번의 수동 단계는 없앨 수 없습니다. 워크플로가 `actions/configure-pages`의 `enablement` 옵션으로 Pages를 직접 켜려면 저장소 관리자 권한이 필요한데, Actions의 기본 `GITHUB_TOKEN`에는 그 권한이 없어서 `Resource not accessible by integration` 으로 실패합니다. Pages가 켜지기 전에는 `actions/deploy-pages` 도 `404 ... Ensure GitHub Pages has been enabled` 로 실패합니다.

기본 브랜치 이름은 무엇이든 상관없습니다. 워크플로는 모든 브랜치의 푸시를 받되 `github.event.repository.default_branch`와 일치할 때만 빌드·배포하므로, 브랜치가 `main`이 아니어도 조용히 아무 일도 일어나지 않는 상황은 생기지 않습니다. 배포 경로(`VITE_BASE`)는 저장소 이름에서 계산해 프로젝트 사이트(`/axdraw/`)와 사용자·조직 사이트(`/`) 모두 맞춥니다.

---

## Excalidraw와의 관계

Excalidraw 코드를 가져오지 않고 처음부터 새로 구현했습니다. 파일 형식과 조작 방식은 익숙하게 쓸 수 있도록 호환을 맞췄고(`.excalidraw` 파일 열기, 같은 단축키), 손그림 렌더링은 rough.js가 쓰는 것과 같은 방식의 알고리즘을 직접 구현했습니다. 도형 자동 인식은 Excalidraw에 없는 기능입니다.

아직 없는 것: 실시간 공동 편집, 도형 라이브러리, 엘보 화살표 자동 경로, 멘탈 모델 상 프레임 기능은 기본 수준(프레임 이동 시 내부 요소 함께 이동)까지만 구현했습니다.

---

## English summary

axdraw is a hand-drawn style whiteboard in the spirit of Excalidraw, written from scratch in dependency-free TypeScript, with one extra headline feature: **sketch recognition**. Draw a rough box, circle, diamond, triangle, line or arrow with the freehand tool and it snaps into a clean shape — tilted boxes keep their angle, near-squares become squares, and anything ambiguous stays freehand.

It covers the full editing surface you would expect: every drawing tool, the complete style panel, multi-select with resize/rotate, groups, z-order, alignment and distribution, arrows that stay bound to the shapes they connect, in-shape labels with wrapping, object snapping and grid, infinite pan/zoom with pinch support, dark mode, laser pointer, unlimited undo, local autosave, PNG/SVG/`.axdraw` export, and it opens Excalidraw scene files. Run `npm run test:e2e` for the browser test suite.
