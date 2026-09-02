/**
 * UI localisation — English, Korean, Japanese, Chinese (simplified), French.
 *
 * English strings double as the dictionary keys, so `t("Stroke width")`
 * falls back to itself for any locale or key with no entry. The UI helpers
 * (section labels, menu items, button titles) call t() once at render time,
 * and changing language reloads the page — the whole chrome rebuilds from
 * state anyway, and a reload keeps this dead simple.
 */

export type Locale = "en" | "ko" | "ja" | "zh" | "fr";

export const LOCALE_NAMES: Record<Locale, string> = {
  en: "English",
  ko: "한국어",
  ja: "日本語",
  zh: "中文",
  fr: "Français",
};

const LANG_KEY = "axdraw:lang";

function detect(): Locale {
  try {
    const stored = localStorage.getItem(LANG_KEY) as Locale | null;
    if (stored && stored in LOCALE_NAMES) return stored;
  } catch {
    // Storage unavailable — fall through to the browser language.
  }
  const nav = (navigator.language || "en").toLowerCase();
  if (nav.startsWith("ko")) return "ko";
  if (nav.startsWith("ja")) return "ja";
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("fr")) return "fr";
  return "en";
}

export const locale: Locale = detect();

export function setLocale(next: Locale): void {
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    // Ignore.
  }
  location.reload();
}

type Dict = Record<string, string>;

const ko: Dict = {
  // Panel
  "Stroke": "선 색", "Background": "배경", "Fill": "채움", "Stroke width": "선 굵기",
  "Stroke style": "선 스타일", "Sloppiness": "손그림 정도", "Edges": "모서리", "Opacity": "투명도",
  "Layers": "레이어 순서", "Actions": "동작", "Font family": "글꼴", "Font size": "글자 크기",
  "Text align": "정렬", "Arrowheads": "화살촉", "Canvas background": "캔버스 배경",
  // Tools
  "Hand (pan)": "손(화면 이동)", "Selection": "선택", "Rectangle": "사각형", "Diamond": "마름모",
  "Ellipse": "타원", "Arrow": "화살표", "Line": "선", "Draw": "그리기", "Text": "텍스트",
  "Image": "이미지", "Eraser": "지우개", "Frame": "프레임", "Laser pointer": "레이저 포인터",
  // Menu / actions
  "Menu": "메뉴", "New canvas": "새 캔버스", "Boards…": "캔버스 목록…", "Open…": "열기…",
  "Save to file": "파일로 저장", "Export image…": "이미지 내보내기…",
  "Copy canvas to clipboard": "캔버스를 클립보드로 복사", "Share link…": "공유 링크…",
  "Live collaboration…": "실시간 협업…", "Stop live collaboration": "실시간 협업 종료",
  "Toggle theme": "다크/라이트 전환", "Keyboard shortcuts": "키보드 단축키",
  "Reset the canvas": "캔버스 비우기", "Templates": "템플릿", "Share": "공유", "Language": "언어",
  "Copy": "복사", "Paste": "붙여넣기", "Duplicate": "복제", "Copy as PNG": "PNG로 복사",
  "Select all": "전체 선택", "Delete": "삭제", "Convert to shape": "도형으로 변환",
  "Attach file…": "파일 첨부…", "Download file": "파일 다운로드",
  "Draw with AI": "AI로 그리기", "Generate": "생성", "Drawing…": "그리는 중…",
  "Describe what to draw — e.g. login flow flowchart": "무엇을 그릴지 설명하세요 — 예: 로그인 흐름 플로차트",
  "AI drawing is not set up on this server yet": "이 서버에는 아직 AI 그리기가 설정되지 않았습니다",
  "The AI could not draw that — try rephrasing": "AI가 그리지 못했습니다 — 다르게 표현해보세요",
  "AI chat": "AI 챗", "Send": "보내기", "Paste to canvas": "캔버스에 붙여넣기",
  "Draw as diagram": "도식으로 그리기",
  "Ask anything — answers can go straight onto the canvas": "무엇이든 물어보세요 — 답변을 바로 캔버스에 넣을 수 있어요",
  "Free AI drawing needs an API key. Get a free Groq key and paste it here — it stays in this browser only.": "AI 기능을 쓰려면 API 키가 필요해요. Groq에서 무료 키를 발급받아 붙여넣으세요 — 키는 이 브라우저에만 저장됩니다.",
  "Save key": "키 저장",
  "Bring to front": "맨 앞으로", "Bring forward": "앞으로", "Send backward": "뒤로",
  "Send to back": "맨 뒤로", "Group selection": "그룹", "Ungroup selection": "그룹 해제",
  "Flip horizontal": "좌우 뒤집기", "Flip vertical": "상하 뒤집기", "Lock": "잠금", "Unlock": "잠금 해제",
  "Zoom to fit": "전체 맞춤", "Unlock all elements": "전체 잠금 해제", "Cancel": "취소",
  "Export image": "이미지 내보내기", "Close": "닫기",
  // Toasts
  "Share link copied to clipboard": "공유 링크를 클립보드에 복사했습니다",
  "Collaboration link copied — anyone with it can draw with you": "협업 링크 복사됨 — 링크를 가진 사람은 함께 그릴 수 있습니다",
  "Left the collaboration room": "협업 방에서 나왔습니다",
  "Joined the collaboration room": "협업 방에 참여했습니다",
  "A collaborator joined": "협업자가 들어왔습니다", "A collaborator left": "협업자가 나갔습니다",
  "Opened a shared drawing": "공유된 그림을 열었습니다", "Nothing to share": "공유할 내용이 없습니다",
  "Shape assist on": "도형 인식 켬", "Shape assist off": "도형 인식 끔",
  // Templates
  "Flowchart": "플로우차트", "Start → process → decision": "시작 → 처리 → 판단 분기",
  "Mind map": "마인드맵", "Central topic with 4 branches": "중심 주제와 가지 4개",
  "Kanban board": "칸반 보드", "To do · Doing · Done": "할 일 · 진행 중 · 완료",
  "Quadrant": "4분면", "SWOT · priority matrix": "SWOT · 중요도/긴급도",
  // Boards
  "Boards": "캔버스", "+ New canvas": "+ 새 캔버스",
  "Rename": "이름 변경", "Rename this canvas": "이 캔버스 이름 변경", "Canvas name": "캔버스 이름",
  "Could not work out where the drawing is": "그림 위치를 계산할 수 없습니다",
  "Copy canvas as SVG": "캔버스를 SVG로 복사", "Copy as SVG": "SVG로 복사", "SVG copied": "SVG를 복사했습니다", "Nothing to export": "내보낼 것이 없습니다",
  "The last canvas cannot be deleted": "마지막 캔버스는 삭제할 수 없습니다",
  // Template contents
  "Start": "시작", "Process": "처리", "Decision?": "판단?", "End": "끝", "Yes": "예", "No": "아니오",
  "Process again": "다시 처리", "Topic": "주제", "Idea": "아이디어",
  "To do": "할 일", "Doing": "진행 중", "Done": "완료", "Card": "카드",
  "1. Important · Urgent": "1. 중요 · 긴급", "2. Important · Later": "2. 중요 · 여유",
  "3. Delegate": "3. 위임", "4. Drop": "4. 제거",
  "Hand-drawn": "손글씨", "System": "시스템", "Code": "코드",
  "Line height": "줄 간격", "Letter spacing": "자간",
};

const ja: Dict = {
  "Stroke": "線の色", "Background": "背景", "Fill": "塗り", "Stroke width": "線の太さ",
  "Stroke style": "線種", "Sloppiness": "手描き度", "Edges": "角", "Opacity": "不透明度",
  "Layers": "重ね順", "Actions": "操作", "Font family": "フォント", "Font size": "文字サイズ",
  "Text align": "揃え", "Arrowheads": "矢印の先端", "Canvas background": "キャンバス背景",
  "Hand (pan)": "手のひら(移動)", "Selection": "選択", "Rectangle": "長方形", "Diamond": "ひし形",
  "Ellipse": "楕円", "Arrow": "矢印", "Line": "直線", "Draw": "ペン", "Text": "テキスト",
  "Image": "画像", "Eraser": "消しゴム", "Frame": "フレーム", "Laser pointer": "レーザーポインター",
  "Menu": "メニュー", "New canvas": "新しいキャンバス", "Boards…": "キャンバス一覧…", "Open…": "開く…",
  "Save to file": "ファイルに保存", "Export image…": "画像を書き出す…",
  "Copy canvas to clipboard": "キャンバスをコピー", "Share link…": "共有リンク…",
  "Live collaboration…": "リアルタイム共同編集…", "Stop live collaboration": "共同編集を終了",
  "Toggle theme": "テーマ切り替え", "Keyboard shortcuts": "キーボードショートカット",
  "Reset the canvas": "キャンバスをクリア", "Templates": "テンプレート", "Share": "共有", "Language": "言語",
  "Copy": "コピー", "Paste": "貼り付け", "Duplicate": "複製", "Copy as PNG": "PNGとしてコピー",
  "Select all": "すべて選択", "Delete": "削除", "Convert to shape": "図形に変換",
  "Attach file…": "ファイルを添付…", "Download file": "ファイルをダウンロード",
  "Draw with AI": "AIで描く", "Generate": "生成", "Drawing…": "描画中…",
  "Describe what to draw — e.g. login flow flowchart": "描きたいものを説明してください — 例: ログインフローの図",
  "AI drawing is not set up on this server yet": "このサーバーではAI描画がまだ設定されていません",
  "The AI could not draw that — try rephrasing": "AIが描けませんでした — 言い換えてみてください",
  "AI chat": "AIチャット", "Send": "送信", "Paste to canvas": "キャンバスに貼り付け",
  "Draw as diagram": "図として描く",
  "Ask anything — answers can go straight onto the canvas": "何でも聞いてください — 回答をそのままキャンバスへ",
  "Free AI drawing needs an API key. Get a free Groq key and paste it here — it stays in this browser only.": "AI機能にはAPIキーが必要です。Groqで無料キーを取得して貼り付けてください — キーはこのブラウザにのみ保存されます。",
  "Save key": "キーを保存",
  "Bring to front": "最前面へ", "Bring forward": "前面へ", "Send backward": "背面へ",
  "Send to back": "最背面へ", "Group selection": "グループ化", "Ungroup selection": "グループ解除",
  "Flip horizontal": "左右反転", "Flip vertical": "上下反転", "Lock": "ロック", "Unlock": "ロック解除",
  "Zoom to fit": "全体表示", "Unlock all elements": "すべてのロックを解除", "Cancel": "キャンセル",
  "Export image": "画像を書き出す", "Close": "閉じる",
  "Share link copied to clipboard": "共有リンクをコピーしました",
  "Collaboration link copied — anyone with it can draw with you": "共同編集リンクをコピーしました — リンクを持つ人と一緒に描けます",
  "Left the collaboration room": "共同編集ルームを退出しました",
  "Joined the collaboration room": "共同編集ルームに参加しました",
  "A collaborator joined": "共同編集者が参加しました", "A collaborator left": "共同編集者が退出しました",
  "Opened a shared drawing": "共有された図面を開きました", "Nothing to share": "共有する内容がありません",
  "Shape assist on": "図形認識オン", "Shape assist off": "図形認識オフ",
  "Flowchart": "フローチャート", "Start → process → decision": "開始 → 処理 → 分岐",
  "Mind map": "マインドマップ", "Central topic with 4 branches": "中心トピックと4つの枝",
  "Kanban board": "カンバンボード", "To do · Doing · Done": "未着手 · 進行中 · 完了",
  "Quadrant": "4象限", "SWOT · priority matrix": "SWOT · 優先度マトリクス",
  "Boards": "キャンバス", "+ New canvas": "+ 新しいキャンバス",
  "Rename": "名前を変更", "Rename this canvas": "このキャンバスの名前を変更", "Canvas name": "キャンバス名",
  "Could not work out where the drawing is": "図の位置を計算できません",
  "Copy canvas as SVG": "キャンバスをSVGでコピー", "Copy as SVG": "SVGでコピー", "SVG copied": "SVGをコピーしました", "Nothing to export": "書き出すものがありません",
  "The last canvas cannot be deleted": "最後のキャンバスは削除できません",
  "Start": "開始", "Process": "処理", "Decision?": "判断?", "End": "終了", "Yes": "はい", "No": "いいえ",
  "Process again": "再処理", "Topic": "テーマ", "Idea": "アイデア",
  "To do": "未着手", "Doing": "進行中", "Done": "完了", "Card": "カード",
  "1. Important · Urgent": "1. 重要 · 緊急", "2. Important · Later": "2. 重要 · 余裕",
  "3. Delegate": "3. 委任", "4. Drop": "4. 削除",
  "Hand-drawn": "手書き", "System": "システム", "Code": "コード",
  "Line height": "行間", "Letter spacing": "字間",
};

const zh: Dict = {
  "Stroke": "描边", "Background": "背景", "Fill": "填充", "Stroke width": "线条粗细",
  "Stroke style": "线型", "Sloppiness": "手绘程度", "Edges": "边角", "Opacity": "不透明度",
  "Layers": "图层顺序", "Actions": "操作", "Font family": "字体", "Font size": "字号",
  "Text align": "对齐", "Arrowheads": "箭头样式", "Canvas background": "画布背景",
  "Hand (pan)": "抓手(平移)", "Selection": "选择", "Rectangle": "矩形", "Diamond": "菱形",
  "Ellipse": "椭圆", "Arrow": "箭头", "Line": "直线", "Draw": "画笔", "Text": "文本",
  "Image": "图片", "Eraser": "橡皮擦", "Frame": "框架", "Laser pointer": "激光笔",
  "Menu": "菜单", "New canvas": "新建画布", "Boards…": "画布列表…", "Open…": "打开…",
  "Save to file": "保存到文件", "Export image…": "导出图片…",
  "Copy canvas to clipboard": "复制画布到剪贴板", "Share link…": "分享链接…",
  "Live collaboration…": "实时协作…", "Stop live collaboration": "结束实时协作",
  "Toggle theme": "切换主题", "Keyboard shortcuts": "键盘快捷键",
  "Reset the canvas": "清空画布", "Templates": "模板", "Share": "分享", "Language": "语言",
  "Copy": "复制", "Paste": "粘贴", "Duplicate": "创建副本", "Copy as PNG": "复制为 PNG",
  "Select all": "全选", "Delete": "删除", "Convert to shape": "转换为图形",
  "Attach file…": "附加文件…", "Download file": "下载文件",
  "Draw with AI": "AI 绘图", "Generate": "生成", "Drawing…": "绘制中…",
  "Describe what to draw — e.g. login flow flowchart": "描述要画什么 — 例如：登录流程图",
  "AI drawing is not set up on this server yet": "此服务器尚未配置 AI 绘图",
  "The AI could not draw that — try rephrasing": "AI 无法绘制 — 请换种说法",
  "AI chat": "AI 聊天", "Send": "发送", "Paste to canvas": "粘贴到画布",
  "Draw as diagram": "绘制为图表",
  "Ask anything — answers can go straight onto the canvas": "随便问 — 回答可直接放到画布上",
  "Free AI drawing needs an API key. Get a free Groq key and paste it here — it stays in this browser only.": "AI 功能需要 API 密钥。在 Groq 免费获取密钥并粘贴到这里 — 密钥只保存在此浏览器中。",
  "Save key": "保存密钥",
  "Bring to front": "置于顶层", "Bring forward": "上移一层", "Send backward": "下移一层",
  "Send to back": "置于底层", "Group selection": "编组", "Ungroup selection": "取消编组",
  "Flip horizontal": "水平翻转", "Flip vertical": "垂直翻转", "Lock": "锁定", "Unlock": "解锁",
  "Zoom to fit": "缩放以适应", "Unlock all elements": "解锁全部", "Cancel": "取消",
  "Export image": "导出图片", "Close": "关闭",
  "Share link copied to clipboard": "分享链接已复制到剪贴板",
  "Collaboration link copied — anyone with it can draw with you": "协作链接已复制 — 拥有链接的人可以与你一起绘制",
  "Left the collaboration room": "已离开协作房间",
  "Joined the collaboration room": "已加入协作房间",
  "A collaborator joined": "有协作者加入", "A collaborator left": "有协作者离开",
  "Opened a shared drawing": "已打开共享图形", "Nothing to share": "没有可分享的内容",
  "Shape assist on": "图形识别已开启", "Shape assist off": "图形识别已关闭",
  "Flowchart": "流程图", "Start → process → decision": "开始 → 处理 → 判断分支",
  "Mind map": "思维导图", "Central topic with 4 branches": "中心主题与四个分支",
  "Kanban board": "看板", "To do · Doing · Done": "待办 · 进行中 · 已完成",
  "Quadrant": "四象限", "SWOT · priority matrix": "SWOT · 优先级矩阵",
  "Boards": "画布", "+ New canvas": "+ 新建画布",
  "Rename": "重命名", "Rename this canvas": "重命名此画布", "Canvas name": "画布名称",
  "Could not work out where the drawing is": "无法确定图形位置",
  "Copy canvas as SVG": "将画布复制为 SVG", "Copy as SVG": "复制为 SVG", "SVG copied": "已复制 SVG", "Nothing to export": "没有可导出的内容",
  "The last canvas cannot be deleted": "最后一个画布无法删除",
  "Start": "开始", "Process": "处理", "Decision?": "判断?", "End": "结束", "Yes": "是", "No": "否",
  "Process again": "重新处理", "Topic": "主题", "Idea": "想法",
  "To do": "待办", "Doing": "进行中", "Done": "已完成", "Card": "卡片",
  "1. Important · Urgent": "1. 重要 · 紧急", "2. Important · Later": "2. 重要 · 从容",
  "3. Delegate": "3. 委派", "4. Drop": "4. 舍弃",
  "Hand-drawn": "手写", "System": "系统", "Code": "代码",
  "Line height": "行距", "Letter spacing": "字距",
};

const fr: Dict = {
  "Stroke": "Trait", "Background": "Fond", "Fill": "Remplissage", "Stroke width": "Épaisseur du trait",
  "Stroke style": "Style de trait", "Sloppiness": "Style dessiné", "Edges": "Coins", "Opacity": "Opacité",
  "Layers": "Ordre", "Actions": "Actions", "Font family": "Police", "Font size": "Taille du texte",
  "Text align": "Alignement", "Arrowheads": "Pointes de flèche", "Canvas background": "Fond du canevas",
  "Hand (pan)": "Main (déplacer)", "Selection": "Sélection", "Rectangle": "Rectangle", "Diamond": "Losange",
  "Ellipse": "Ellipse", "Arrow": "Flèche", "Line": "Ligne", "Draw": "Crayon", "Text": "Texte",
  "Image": "Image", "Eraser": "Gomme", "Frame": "Cadre", "Laser pointer": "Pointeur laser",
  "Menu": "Menu", "New canvas": "Nouveau canevas", "Boards…": "Canevas…", "Open…": "Ouvrir…",
  "Save to file": "Enregistrer dans un fichier", "Export image…": "Exporter l'image…",
  "Copy canvas to clipboard": "Copier le canevas", "Share link…": "Lien de partage…",
  "Live collaboration…": "Collaboration en direct…", "Stop live collaboration": "Arrêter la collaboration",
  "Toggle theme": "Changer de thème", "Keyboard shortcuts": "Raccourcis clavier",
  "Reset the canvas": "Vider le canevas", "Templates": "Modèles", "Share": "Partager", "Language": "Langue",
  "Copy": "Copier", "Paste": "Coller", "Duplicate": "Dupliquer", "Copy as PNG": "Copier en PNG",
  "Select all": "Tout sélectionner", "Delete": "Supprimer", "Convert to shape": "Convertir en forme",
  "Attach file…": "Joindre un fichier…", "Download file": "Télécharger le fichier",
  "Draw with AI": "Dessiner avec l'IA", "Generate": "Générer", "Drawing…": "Dessin en cours…",
  "Describe what to draw — e.g. login flow flowchart": "Décrivez le dessin — ex. : organigramme de connexion",
  "AI drawing is not set up on this server yet": "Le dessin IA n'est pas encore configuré sur ce serveur",
  "The AI could not draw that — try rephrasing": "L'IA n'a pas pu dessiner cela — reformulez",
  "AI chat": "Chat IA", "Send": "Envoyer", "Paste to canvas": "Coller sur le canevas",
  "Draw as diagram": "Dessiner en diagramme",
  "Ask anything — answers can go straight onto the canvas": "Demandez tout — les réponses vont droit sur le canevas",
  "Free AI drawing needs an API key. Get a free Groq key and paste it here — it stays in this browser only.": "Les fonctions IA nécessitent une clé API. Obtenez une clé Groq gratuite et collez-la ici — elle reste dans ce navigateur uniquement.",
  "Save key": "Enregistrer la clé",
  "Bring to front": "Premier plan", "Bring forward": "Avancer", "Send backward": "Reculer",
  "Send to back": "Arrière-plan", "Group selection": "Grouper", "Ungroup selection": "Dégrouper",
  "Flip horizontal": "Miroir horizontal", "Flip vertical": "Miroir vertical", "Lock": "Verrouiller", "Unlock": "Déverrouiller",
  "Zoom to fit": "Ajuster le zoom", "Unlock all elements": "Tout déverrouiller", "Cancel": "Annuler",
  "Export image": "Exporter l'image", "Close": "Fermer",
  "Share link copied to clipboard": "Lien de partage copié",
  "Collaboration link copied — anyone with it can draw with you": "Lien de collaboration copié — quiconque l'a peut dessiner avec vous",
  "Left the collaboration room": "Vous avez quitté la salle",
  "Joined the collaboration room": "Salle de collaboration rejointe",
  "A collaborator joined": "Un collaborateur a rejoint", "A collaborator left": "Un collaborateur est parti",
  "Opened a shared drawing": "Dessin partagé ouvert", "Nothing to share": "Rien à partager",
  "Shape assist on": "Reconnaissance activée", "Shape assist off": "Reconnaissance désactivée",
  "Flowchart": "Organigramme", "Start → process → decision": "Début → traitement → décision",
  "Mind map": "Carte mentale", "Central topic with 4 branches": "Sujet central et 4 branches",
  "Kanban board": "Tableau kanban", "To do · Doing · Done": "À faire · En cours · Terminé",
  "Quadrant": "Quatre quadrants", "SWOT · priority matrix": "SWOT · matrice de priorité",
  "Boards": "Canevas", "+ New canvas": "+ Nouveau canevas",
  "Rename": "Renommer", "Rename this canvas": "Renommer ce canevas", "Canvas name": "Nom du canevas",
  "Could not work out where the drawing is": "Impossible de situer le dessin",
  "Copy canvas as SVG": "Copier le canevas en SVG", "Copy as SVG": "Copier en SVG", "SVG copied": "SVG copié", "Nothing to export": "Rien à exporter",
  "The last canvas cannot be deleted": "Le dernier canevas ne peut pas être supprimé",
  "Start": "Début", "Process": "Traitement", "Decision?": "Décision ?", "End": "Fin", "Yes": "Oui", "No": "Non",
  "Process again": "Retraiter", "Topic": "Sujet", "Idea": "Idée",
  "To do": "À faire", "Doing": "En cours", "Done": "Terminé", "Card": "Carte",
  "1. Important · Urgent": "1. Important · Urgent", "2. Important · Later": "2. Important · Plus tard",
  "3. Delegate": "3. Déléguer", "4. Drop": "4. Abandonner",
  "Hand-drawn": "Manuscrite", "System": "Système",
  "Line height": "Interligne", "Letter spacing": "Espacement",
};

const DICTS: Partial<Record<Locale, Dict>> = { ko, ja, zh, fr };

/** Translate an English UI string into the active locale (fallback: as-is). */
export function t(text: string): string {
  return DICTS[locale]?.[text] ?? text;
}
