const DATA = window.PCPR_DATA;
const KEY = "rota-pcpr-gran-v3";
const LEGACY_KEY = "rota-pcpr-gran-v2";
const LESSONS = new Map(DATA.lessons.map((lesson) => [lesson.id, lesson]));
const BASELINE = new Map(DATA.lessons.map((lesson) => [lesson.id, lesson.baselineDay]));

const baseState = {
  version: 3,
  done: {},
  completedDay: {},
  reviewDone: {},
  reviewLog: {},
  flexLog: {},
  currentDay: 1,
  viewDay: 1,
  theme: "light",
};

let activeTab = "today";
let liveSchedule;
let reviewSessionCache = new Map();

const $ = (selector) => document.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function escapeHTML(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeState(stored = {}) {
  return {
    ...baseState,
    ...stored,
    version: 3,
    done: stored.done || {},
    completedDay: stored.completedDay || {},
    reviewDone: stored.reviewDone || {},
    reviewLog: stored.reviewLog || {},
    flexLog: stored.flexLog || {},
    currentDay: clamp(Number(stored.currentDay) || 1, 1, DATA.totalDays),
    viewDay: clamp(Number(stored.viewDay) || Number(stored.currentDay) || 1, 1, DATA.totalDays),
  };
}

function migrateLegacyState(legacy = {}) {
  const migrated = normalizeState({
    currentDay: legacy.currentDay,
    viewDay: legacy.viewDay,
    theme: legacy.theme,
  });
  for (const lesson of DATA.lessons) {
    if (!lesson.legacyBlockId || !legacy.done?.[lesson.legacyBlockId]) continue;
    migrated.done[lesson.id] = true;
    migrated.completedDay[lesson.id] = clamp(Number(legacy.completedDay?.[lesson.legacyBlockId]) || lesson.baselineDay, 1, DATA.totalDays);
  }
  return migrated;
}

function loadState() {
  try {
    const current = JSON.parse(localStorage.getItem(KEY) || "null");
    if (current) return normalizeState(current);
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
    if (legacy) return migrateLegacyState(legacy);
  } catch {
    // Um backup inválido não impede a abertura do aplicativo.
  }
  return { ...baseState };
}

let state = loadState();

function save() {
  localStorage.setItem(KEY, JSON.stringify(state));
  render();
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => element.classList.remove("show"), 1900);
}

function isDone(lessonOrId) {
  const id = typeof lessonOrId === "string" ? lessonOrId : lessonOrId.id;
  return Boolean(state.done[id]);
}

function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder} min`;
  return remainder ? `${hours}h${String(remainder).padStart(2, "0")}` : `${hours}h`;
}

function capacityFor(dayNumber) {
  return DATA.dayCapacities[dayNumber - 1]?.studyMinutes || 300;
}

function newPlanDay(dayNumber) {
  const capacity = DATA.dayCapacities[dayNumber - 1] || {};
  return {
    day: dayNumber,
    phase: capacity.phase || "Rotina · 5h",
    studyMinutes: capacity.studyMinutes || 300,
    lessonIds: [],
    minutes: 0,
  };
}

function canTakeCandidate(pending, index, remainingMinutes) {
  const candidate = pending[index];
  if (candidate.minutes > remainingMinutes) return false;
  for (let earlier = 0; earlier < index; earlier += 1) {
    if (pending[earlier].subject === candidate.subject) return false;
  }
  return true;
}

function packPending(days, pending, firstDay, lastDay) {
  for (let dayNumber = firstDay; dayNumber <= lastDay && pending.length; dayNumber += 1) {
    const day = days[dayNumber - 1];
    while (day.lessonIds.length < 26) {
      const remaining = day.studyMinutes - day.minutes;
      if (remaining < DATA.baseLessonMinutes) break;
      let candidateIndex = -1;
      const searchLimit = Math.min(pending.length, 120);
      for (let index = 0; index < searchLimit; index += 1) {
        if (canTakeCandidate(pending, index, remaining)) {
          candidateIndex = index;
          break;
        }
      }
      if (candidateIndex < 0) break;
      const [lesson] = pending.splice(candidateIndex, 1);
      day.lessonIds.push(lesson.id);
      day.minutes += lesson.minutes;
    }
  }
}

function buildLiveSchedule() {
  if (state.currentDay === 1 && !DATA.lessons.some((lesson) => isDone(lesson))) {
    const baselineDays = DATA.baselineDays.map((day) => ({
      day: day.day,
      phase: day.phase,
      studyMinutes: day.studyMinutes,
      lessonIds: [...day.lessonIds],
      minutes: day.minutes,
    }));
    return {
      days: baselineDays,
      overflow: [],
      forecastDay: DATA.studyDays,
      lastScheduledDay: DATA.studyDays,
    };
  }

  const days = Array.from({ length: DATA.totalDays }, (_, index) => newPlanDay(index + 1));
  for (const lesson of DATA.lessons) {
    if (!isDone(lesson)) continue;
    const completedOn = clamp(Number(state.completedDay[lesson.id]) || lesson.baselineDay, 1, DATA.totalDays);
    days[completedOn - 1].lessonIds.push(lesson.id);
    days[completedOn - 1].minutes += lesson.minutes;
  }

  const pending = DATA.lessons
    .filter((lesson) => !isDone(lesson))
    .sort((a, b) => {
      const aOverdue = a.baselineDay < state.currentDay ? 0 : 1;
      const bOverdue = b.baselineDay < state.currentDay ? 0 : 1;
      return aOverdue - bOverdue || a.baselineDay - b.baselineDay || a.order - b.order;
    });

  packPending(days, pending, state.currentDay, DATA.totalDays);
  const scheduledDays = days.filter((day) => day.lessonIds.length);
  const lastScheduledDay = scheduledDays.length ? scheduledDays.at(-1).day : state.currentDay;
  const overflowMinutes = pending.reduce((sum, lesson) => sum + lesson.minutes, 0);
  const forecastDay = pending.length
    ? DATA.totalDays + Math.ceil(overflowMinutes / capacityFor(DATA.totalDays))
    : lastScheduledDay;

  return { days, overflow: pending, forecastDay, lastScheduledDay };
}

function densityMeta(lesson) {
  if (lesson.density === "densa") return { label: "Densa", icon: "●", className: "dense" };
  return { label: "Base", icon: "●", className: "short" };
}

function lessonHTML(lesson, completionDay, compact = false) {
  const done = isDone(lesson);
  const density = densityMeta(lesson);
  const context = [lesson.granTopic, lesson.professor, lesson.duration].filter(Boolean).join(" · ");
  return `<article class="study-block lesson-unit ${done ? "done" : ""} ${compact ? "compact" : ""}">
    <label class="block-checkline">
      <input class="check" type="checkbox" data-lesson-id="${lesson.id}" data-completion-day="${completionDay}" ${done ? "checked" : ""}>
      <span class="block-main">
        <span class="subject">${escapeHTML(lesson.subject)}</span>
        <span class="block-title">${lesson.priority ? '<span class="star" title="Prioritária">★</span> ' : ""}${escapeHTML(lesson.title)}</span>
        <small class="lesson-context">${escapeHTML(context)}</small>
      </span>
      <span class="block-tags">
        <span class="density ${density.className}">${density.icon} ${density.label}</span>
        <span class="qtag">${lesson.minutes} min</span>
        <span class="qtag">2 questões</span>
      </span>
    </label>
    ${compact ? "" : `<details class="gran-list"><summary>Conteúdo da aula</summary><p>${escapeHTML(lesson.parent)}</p></details>`}
  </article>`;
}

function lessonReviewKey(lessonId, lag) {
  return `${lessonId}@${lag}`;
}

function reviewItemsDueBy(dayNumber) {
  const items = [];
  for (const lesson of DATA.lessons) {
    if (!isDone(lesson)) continue;
    const completedOn = Number(state.completedDay[lesson.id]) || lesson.baselineDay;
    for (const lag of DATA.reviewIntervals) {
      const dueDay = completedOn + lag;
      const key = lessonReviewKey(lesson.id, lag);
      if (dueDay <= dayNumber && !state.reviewDone[key]) items.push({ key, lesson, lag, dueDay });
    }
  }
  return items;
}

function reviewGroups(dayNumber) {
  const groups = new Map();
  for (const item of reviewItemsDueBy(dayNumber)) {
    if (!groups.has(item.lesson.subject)) groups.set(item.lesson.subject, []);
    groups.get(item.lesson.subject).push(item);
  }
  return [...groups.entries()]
    .map(([subject, items]) => ({
      subject,
      items: items.sort((a, b) => a.dueDay - b.dueDay || a.lag - b.lag),
      earliest: Math.min(...items.map((item) => item.dueDay)),
      priority: items.some((item) => item.lesson.priority),
    }))
    .sort((a, b) => a.earliest - b.earliest || Number(b.priority) - Number(a.priority) || a.subject.localeCompare(b.subject, "pt-BR"));
}

function renderReviewCard(dayNumber) {
  reviewSessionCache = new Map();
  const logged = state.reviewLog[dayNumber] || {};
  const completedSessions = Object.entries(logged);
  const availableSlots = Math.max(0, DATA.maxReviewSubjects - completedSessions.length);
  const groups = reviewGroups(dayNumber);
  const selected = groups.slice(0, availableSlots);
  const overflow = Math.max(0, groups.length - availableSlots);

  const completedHTML = completedSessions.map(([subject, session]) => `<label class="review-session completed">
    <input class="check" type="checkbox" data-review-log="${encodeURIComponent(subject)}" data-review-day="${dayNumber}" checked>
    <span><b>${escapeHTML(subject)}</b><small>${session.lessonIds.length} aula${session.lessonIds.length === 1 ? "" : "s"} revisada${session.lessonIds.length === 1 ? "" : "s"} no Anki</small></span>
    <span class="review-time">20 min</span>
  </label>`).join("");

  const pendingHTML = selected.map((group, index) => {
    const sessionId = `review-${dayNumber}-${index}`;
    reviewSessionCache.set(sessionId, group);
    const lags = [...new Set(group.items.map((item) => item.lag))].sort((a, b) => a - b);
    const overdue = group.earliest < dayNumber;
    return `<label class="review-session ${overdue ? "overdue" : ""}">
      <input class="check" type="checkbox" data-review-session="${sessionId}">
      <span><b>${escapeHTML(group.subject)}</b><small>${group.items.length} aula${group.items.length === 1 ? "" : "s"} · ${lags.map((lag) => `D+${lag}`).join(", ")}${overdue ? " · pendente" : ""}</small></span>
      <span class="review-time">20 min</span>
    </label>`;
  }).join("");

  const totalSessions = completedSessions.length + selected.length;
  const empty = !totalSessions
    ? '<div class="empty-state"><b>Nenhuma revisão vencida.</b><span>O Anki aparecerá aqui quando você concluir aulas.</span></div>'
    : "";

  return `<aside class="card review">
    <div class="card-title"><div><h4>Revisão noturna no Anki</h4><span class="meta">Até 6 matérias diferentes</span></div><span class="review-total">${totalSessions * 20} / 120 min</span></div>
    <div class="review-list">${completedHTML}${pendingHTML}${empty}</div>
    ${overflow ? `<div class="overflow-note">${overflow} matéria${overflow === 1 ? "" : "s"} ficará${overflow === 1 ? "" : "ão"} na fila automática para o próximo dia.</div>` : ""}
    <div class="method"><b>Ciclo:</b> D+1, D+3, D+7, D+21, D+35, D+45, D+65 e D+80. Aulas da mesma matéria são reunidas em uma sessão de 20 minutos.</div>
  </aside>`;
}

function renderFlexibleHour(dayNumber) {
  const entry = state.flexLog[dayNumber] || { mode: "portugues", done: false };
  const topic = DATA.portugueseReview.rotation[(dayNumber - 1) % DATA.portugueseReview.rotation.length];
  const modeLabels = {
    portugues: "Português por questões",
    densa: "Complementar aula densa",
    atraso: "Recuperar aula atrasada",
    anki: "Anki extra",
    descanso: "Não usar neste dia",
  };
  const description = entry.mode === "portugues"
    ? `Sugestão para este dia: ${topic}`
    : entry.mode === "densa"
      ? "Use para terminar a análise de uma aula que ultrapassou o tempo-base."
      : entry.mode === "atraso"
        ? "Use para recolocar uma aula pendente no ritmo do cronograma."
        : entry.mode === "anki"
          ? "Use quando o volume de cartões vencidos estiver acima do normal."
          : "Esta hora é opcional e pode virar descanso sem prejudicar a meta-base.";

  return `<aside class="card flex-card ${entry.done ? "flex-complete" : ""}">
    <div class="card-title"><div><h4>3ª hora flexível</h4><span class="meta">Destino principal: Português</span></div><span class="review-total">até 60 min</span></div>
    <label class="field compact-field"><span>Como usar neste dia</span><select data-flex-mode="${dayNumber}">
      ${Object.entries(modeLabels).map(([value, label]) => `<option value="${value}" ${entry.mode === value ? "selected" : ""}>${label}</option>`).join("")}
    </select></label>
    <p class="flex-suggestion">${escapeHTML(description)}</p>
    <label class="review-session flex-check"><input class="check" type="checkbox" data-flex-done="${dayNumber}" ${entry.done ? "checked" : ""}><span><b>Hora flexível encerrada</b><small>Marque somente se decidiu utilizá-la ou descansar.</small></span></label>
  </aside>`;
}

function dayProgress(day) {
  if (!day.lessonIds.length) return 0;
  return Math.round(day.lessonIds.filter((id) => isDone(id)).length / day.lessonIds.length * 100);
}

function renderToday() {
  const day = liveSchedule.days[state.viewDay - 1];
  const lessons = day.lessonIds.map((id) => LESSONS.get(id)).filter(Boolean);
  const isCurrent = state.viewDay === state.currentDay;
  const pendingLessons = lessons.filter((lesson) => !isDone(lesson));
  const plannedMinutes = lessons.reduce((sum, lesson) => sum + lesson.minutes, 0);
  const overdueCount = pendingLessons.filter((lesson) => BASELINE.get(lesson.id) < state.currentDay).length;

  $("#dayBadge").textContent = `DIA ${state.viewDay} DE ${DATA.totalDays}${isCurrent ? " · ATUAL" : ""}`;
  $("#headline").textContent = lessons.length
    ? `${lessons.length} aula${lessons.length === 1 ? "" : "s"} · ${formatMinutes(plannedMinutes)} planejadas`
    : "Dia de segurança e consolidação.";
  $("#subline").textContent = overdueCount
    ? `${overdueCount} aula${overdueCount === 1 ? " atrasada foi reposicionada" : "s atrasadas foram reposicionadas"} automaticamente.`
    : `${day.phase} · duas questões por aula.`;

  const morning = lessons.length
    ? `<div class="card morning-card">
        <div class="card-title"><div><h4>Estudo novo</h4><span class="meta">${day.phase} · estudo reverso</span></div><span class="load-pill">${formatMinutes(plannedMinutes)} / ${formatMinutes(day.studyMinutes)}</span></div>
        <div class="load-track"><i style="width:${Math.min(100, Math.round(plannedMinutes / day.studyMinutes * 100))}%"></i></div>
        <div class="blocks-list">${lessons.map((lesson) => lessonHTML(lesson, state.viewDay)).join("")}</div>
        <div class="method"><b>Método:</b> resolva 2 questões de cada aula, disseque as alternativas, confira a explicação e envie ao Anki somente o que precisa reaparecer. Aulas densas recebem 30 minutos.</div>
      </div>`
    : `<div class="card reserve-card"><span class="reserve-icon">✓</span><h4>Janela de segurança</h4><p>Use para atrasos, pontos fracos ou revisão final. Se houver pendências, o aplicativo as trará automaticamente para este espaço.</p></div>`;

  $("#today").innerHTML = `<div class="day-head">
      <div><h3>Dia ${state.viewDay}</h3><p>${isCurrent ? "Este é o dia usado para redistribuir o planejamento." : `Seu dia atual está definido como Dia ${state.currentDay}.`}</p></div>
      <div class="day-actions">
        ${isCurrent ? "" : '<button class="btn current-day-button">Ir ao dia atual</button>'}
        <button class="btn day-nav" data-direction="-1" aria-label="Dia anterior">←</button>
        <button class="btn day-nav" data-direction="1" aria-label="Próximo dia">→</button>
      </div>
    </div>
    <div class="study-grid">${morning}<div class="night-column">${renderReviewCard(state.viewDay)}${renderFlexibleHour(state.viewDay)}</div></div>`;

  bindLessonChecks($("#today"));
  bindReviewChecks();
  bindFlexibleHour();
  $$(".day-nav", $("#today")).forEach((button) => {
    button.addEventListener("click", () => {
      state.viewDay = clamp(state.viewDay + Number(button.dataset.direction), 1, DATA.totalDays);
      save();
    });
  });
  $(".current-day-button")?.addEventListener("click", () => {
    state.viewDay = state.currentDay;
    save();
  });
}

function renderPlan() {
  const rows = liveSchedule.days.map((day) => {
    const lessons = day.lessonIds.map((id) => LESSONS.get(id)).filter(Boolean);
    const progress = dayProgress(day);
    const subjects = [...new Set(lessons.map((lesson) => lesson.subject))];
    const moved = lessons.some((lesson) => !isDone(lesson) && lesson.baselineDay !== day.day);
    const description = lessons.length ? subjects.slice(0, 3).join(" · ") : "Reserva, atrasos ou revisão final";
    return `<button class="day-row ${day.day === state.currentDay ? "current" : ""}" data-day="${day.day}">
      <strong>Dia ${day.day}</strong>
      <div><b>${escapeHTML(description)}</b><span class="day-meta">${lessons.length} aula${lessons.length === 1 ? "" : "s"} · ${formatMinutes(day.minutes)} de ${formatMinutes(day.studyMinutes)}${moved ? " · reorganizado" : ""}</span><div class="progress"><i style="width:${progress}%"></i></div></div>
      <small>${progress}% concluído</small>
      <span>›</span>
    </button>`;
  }).join("");

  $("#plan").innerHTML = `<div class="day-head"><div><h3>Plano completo</h3><p>Cada aula aparece separadamente e as pendências são redistribuídas.</p></div><span class="audit-pill">Todas as ${DATA.lessons.length} aulas alocadas</span></div><div class="day-list">${rows}</div>`;
  $$(".day-row", $("#plan")).forEach((button) => {
    button.addEventListener("click", () => {
      state.viewDay = Number(button.dataset.day);
      save();
      activate("today");
    });
  });
}

function groupedLessonCatalog(lessons, completionDay) {
  const topics = new Map();
  for (const lesson of lessons) {
    if (!topics.has(lesson.granTopic)) topics.set(lesson.granTopic, { parent: lesson.parent, lessons: [] });
    topics.get(lesson.granTopic).lessons.push(lesson);
  }
  return [...topics.entries()].map(([topic, group]) => `<section class="topic-group">
    <div class="topic-head"><b>${escapeHTML(topic)}</b><span>${group.lessons.length} aula${group.lessons.length === 1 ? "" : "s"}</span></div>
    <p>${escapeHTML(group.parent)}</p>
    <div>${group.lessons.map((lesson) => lessonHTML(lesson, completionDay, true)).join("")}</div>
  </section>`).join("");
}

function portugueseCatalogHTML() {
  const topics = new Map();
  for (const lesson of DATA.portugueseReview.lessons) {
    if (!topics.has(lesson.granTopic)) topics.set(lesson.granTopic, { parent: lesson.parent, lessons: [] });
    topics.get(lesson.granTopic).lessons.push(lesson);
  }
  return [...topics.entries()].map(([topic, group]) => `<section class="topic-group review-only-topic">
    <div class="topic-head"><b>${escapeHTML(topic)}</b><span>${group.lessons.length} aula${group.lessons.length === 1 ? "" : "s"}</span></div>
    <p>${escapeHTML(group.parent)}</p>
    <ol class="review-catalog">${group.lessons.map((lesson) => `<li><span>${escapeHTML(lesson.title)}</span><small>${[lesson.duration, lesson.professor].filter(Boolean).map(escapeHTML).join(" · ")}</small></li>`).join("")}</ol>
  </section>`).join("");
}

function renderSubjects() {
  const groups = new Map(DATA.subjects.map((subject) => [subject.name, []]));
  for (const lesson of DATA.lessons) groups.get(lesson.subject)?.push(lesson);

  const cards = [...groups.entries()].map(([subject, lessons]) => {
    const completed = lessons.filter(isDone).length;
    const missing = lessons.length - completed;
    const progress = Math.round(completed / lessons.length * 100);
    return `<article class="subject-card">
      <div class="subject-card-head"><div><h4>${escapeHTML(subject)}</h4><span class="meta">${completed} concluídas · ${missing} faltam</span></div><strong>${progress}%</strong></div>
      <div class="progress"><i style="width:${progress}%"></i></div>
      <div class="subject-summary"><span>${lessons.length} aulas</span><span>${lessons.filter((lesson) => lesson.density === "densa").length} densas</span><span>${lessons.filter((lesson) => lesson.priority).length} prioritárias ⭐</span></div>
      <details class="subject-details"><summary>Ver todas as aulas da matéria</summary><div class="subject-blocks">${groupedLessonCatalog(lessons, state.currentDay)}</div></details>
    </article>`;
  }).join("");

  const portuguese = `<article class="subject-card portuguese-card">
    <div class="subject-card-head"><div><h4>Língua Portuguesa</h4><span class="meta">Somente revisão na 3ª hora flexível</span></div><strong class="review-only-label">REVISÃO</strong></div>
    <div class="progress review-progress"><i style="width:100%"></i></div>
    <div class="subject-summary"><span>${DATA.portugueseReview.lessons.length} aulas no catálogo</span><span>questões FGV</span><span>fora do estudo novo</span></div>
    <details class="subject-details"><summary>Ver o catálogo de aulas para revisão</summary><div class="subject-blocks">${portugueseCatalogHTML()}</div></details>
  </article>`;

  $("#subjects").innerHTML = `<div class="day-head"><div><h3>Progresso por matéria</h3><p>Cada aula possui sua própria marcação. Português permanece apenas como revisão.</p></div></div><div class="subject-grid">${cards}${portuguese}</div>`;
  bindLessonChecks($("#subjects"));
}

function renderSettings() {
  const source = DATA.source;
  $("#settings").innerHTML = `<div class="day-head"><div><h3>Ajustes e segurança</h3><p>O progresso fica apenas neste computador e neste navegador.</p></div></div>
    <div class="settings">
      <article class="card">
        <h4>Definir o dia atual</h4>
        <p class="meta">Ao avançar o dia, qualquer aula não concluída é reposicionada automaticamente.</p>
        <label class="field"><span>Dia atual do planejamento</span><input id="dayInput" type="number" min="1" max="${DATA.totalDays}" value="${state.currentDay}"></label>
        <button id="setCurrentDay" class="btn primary">Definir e reorganizar</button>
      </article>
      <article class="card">
        <h4>Backup do progresso</h4>
        <p class="meta">Exporte regularmente para restaurar as marcações se trocar de navegador ou pasta.</p>
        <div class="button-line"><button id="export" class="btn">Exportar backup</button><label class="btn">Importar backup<input id="import" type="file" accept="application/json" hidden></label><button id="reset" class="btn danger">Zerar tudo</button></div>
      </article>
      <article class="card audit-card">
        <h4>Conferência do conteúdo Gran</h4>
        <dl>
          <div><dt>Aulas no estudo novo</dt><dd>${source.includedLessons}</dd></div>
          <div><dt>Português</dt><dd>${source.portugueseReviewLessons} aulas · só revisão</dd></div>
          <div><dt>Aulas densas</dt><dd>${source.denseLessons} · 30 min</dd></div>
          <div><dt>Inteligência Emocional</dt><dd>Removida (${source.excludedIntelligenceLessons})</dd></div>
          <div><dt>Apresentações</dt><dd>Removidas (${source.excludedPresentations})</dd></div>
          <div><dt>RLM puramente prático</dt><dd>Removido (${source.excludedRlmLessons})</dd></div>
          <div><dt>Margem real</dt><dd>${formatMinutes(source.bufferMinutes)}</dd></div>
        </dl>
      </article>
      <article class="card legend-card">
        <h4>Nova carga de estudo</h4>
        <p><span class="density short">● Aula-base · 20 min</span> Duas questões dissecadas por aula.</p>
        <p><span class="density dense">● Aula densa · 30 min</span> Tempo adicional já reservado no cronograma.</p>
        <p><b>Julho, setembro e outubro:</b> até 5h de estudo novo.</p>
        <p><b>Agosto:</b> até 8h de estudo novo por dia.</p>
        <p><b>Noite:</b> 2h de Anki + 1h flexível, preferencialmente para Português.</p>
        <p class="meta">⭐ indica maior prioridade histórica, sem excluir os demais conteúdos.</p>
      </article>
      <article class="card rlm-card">
        <h4>Cortes de Raciocínio Lógico</h4>
        <p class="meta">Somente aulas predominantemente intuitivas ou de treino foram retiradas do estudo novo:</p>
        <ul>${DATA.rlmExclusions.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>
      </article>
      <article class="card portuguese-settings">
        <h4>Português na hora flexível</h4>
        <p class="meta">A sugestão gira automaticamente entre os pontos mais importantes para a FGV:</p>
        <ul>${DATA.portugueseReview.rotation.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>
      </article>
    </div>`;

  $("#setCurrentDay").addEventListener("click", () => {
    state.currentDay = clamp(Number($("#dayInput").value) || 1, 1, DATA.totalDays);
    state.viewDay = state.currentDay;
    save();
    toast("Planejamento reorganizado");
    activate("today");
  });

  $("#export").addEventListener("click", () => {
    const payload = { app: "Rota PCPR", version: 3, exportedAt: new Date().toISOString(), state };
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    link.download = "backup-rota-pcpr-aulas-80-dias.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });

  $("#import").addEventListener("change", async (event) => {
    try {
      const payload = JSON.parse(await event.target.files[0].text());
      const restored = payload.state || payload;
      state = restored.version === 2 ? migrateLegacyState(restored) : normalizeState(restored);
      save();
      toast("Backup restaurado");
    } catch {
      toast("Não foi possível importar esse arquivo");
    }
  });

  $("#reset").addEventListener("click", () => {
    if (!window.confirm("Zerar todo o progresso, revisões e dia atual?")) return;
    const theme = state.theme;
    state = { ...baseState, theme };
    save();
    toast("Progresso zerado");
  });
}

function clearReviewsForLesson(lessonId) {
  for (const key of Object.keys(state.reviewDone)) {
    if (key.startsWith(`${lessonId}@`)) delete state.reviewDone[key];
  }
  for (const [day, sessions] of Object.entries(state.reviewLog)) {
    for (const [subject, session] of Object.entries(sessions)) {
      session.keys = session.keys.filter((key) => !key.startsWith(`${lessonId}@`));
      session.lessonIds = session.lessonIds.filter((id) => id !== lessonId);
      if (!session.keys.length) delete state.reviewLog[day][subject];
    }
    if (!Object.keys(state.reviewLog[day]).length) delete state.reviewLog[day];
  }
}

function bindLessonChecks(root) {
  $$('[data-lesson-id]', root).forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const id = checkbox.dataset.lessonId;
      if (checkbox.checked) {
        state.done[id] = true;
        state.completedDay[id] = clamp(Number(checkbox.dataset.completionDay) || state.currentDay, 1, DATA.totalDays);
        save();
        toast("Aula concluída ✓");
      } else {
        delete state.done[id];
        delete state.completedDay[id];
        clearReviewsForLesson(id);
        save();
        toast("Aula devolvida ao planejamento");
      }
    });
  });
}

function bindReviewChecks() {
  $$('[data-review-session]', $("#today")).forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      const group = reviewSessionCache.get(checkbox.dataset.reviewSession);
      if (!group || !checkbox.checked) return;
      for (const item of group.items) state.reviewDone[item.key] = true;
      state.reviewLog[state.viewDay] ||= {};
      state.reviewLog[state.viewDay][group.subject] = {
        keys: group.items.map((item) => item.key),
        lessonIds: [...new Set(group.items.map((item) => item.lesson.id))],
      };
      save();
      toast("Revisão concluída no Anki ✓");
    });
  });

  $$('[data-review-log]', $("#today")).forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) return;
      const day = checkbox.dataset.reviewDay;
      const subject = decodeURIComponent(checkbox.dataset.reviewLog);
      const session = state.reviewLog[day]?.[subject];
      if (!session) return;
      for (const key of session.keys) delete state.reviewDone[key];
      delete state.reviewLog[day][subject];
      if (!Object.keys(state.reviewLog[day]).length) delete state.reviewLog[day];
      save();
      toast("Revisão devolvida à fila");
    });
  });
}

function bindFlexibleHour() {
  const select = $("[data-flex-mode]", $("#today"));
  select?.addEventListener("change", () => {
    const day = select.dataset.flexMode;
    state.flexLog[day] = { ...(state.flexLog[day] || {}), mode: select.value, done: false };
    save();
  });
  const checkbox = $("[data-flex-done]", $("#today"));
  checkbox?.addEventListener("change", () => {
    const day = checkbox.dataset.flexDone;
    const selectMode = $("[data-flex-mode]", $("#today"))?.value || "portugues";
    state.flexLog[day] = { mode: selectMode, done: checkbox.checked };
    save();
    toast(checkbox.checked ? "Hora flexível registrada ✓" : "Hora flexível reaberta");
  });
}

function renderStats() {
  const completed = DATA.lessons.filter(isDone).length;
  const percentage = Math.round(completed / DATA.lessons.length * 100);
  const completeDays = liveSchedule.days.filter((day) => day.lessonIds.length && day.lessonIds.every((id) => isDone(id))).length;
  $("#doneCount").textContent = `${completed} / ${DATA.lessons.length}`;
  $("#daysDone").textContent = `${completeDays} / ${DATA.totalDays}`;
  $("#forecast").textContent = liveSchedule.forecastDay <= DATA.totalDays ? `Dia ${liveSchedule.forecastDay}` : `Dia ${liveSchedule.forecastDay} ⚠`;
  $("#pending").textContent = String(DATA.lessons.length - completed);
  $("#pct").textContent = `${percentage}%`;
  $("#ring").style.background = `conic-gradient(var(--gold) ${percentage}%, #ffffff20 0)`;

  const banner = $("#riskBanner");
  if (liveSchedule.overflow.length) {
    banner.hidden = false;
    banner.innerHTML = `<b>Atenção:</b> com o dia atual e as pendências marcadas, ${liveSchedule.overflow.length} aula${liveSchedule.overflow.length === 1 ? " ultrapassa" : "s ultrapassam"} o Dia 80. Use a hora flexível ou aumente temporariamente a carga.`;
  } else {
    banner.hidden = true;
    banner.textContent = "";
  }
}

function activate(id) {
  activeTab = id;
  $$(".tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tab === id));
  $$(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === id));
}

function render() {
  document.body.classList.toggle("dark", state.theme === "dark");
  liveSchedule = buildLiveSchedule();
  renderToday();
  renderPlan();
  renderSubjects();
  renderSettings();
  renderStats();
  activate(activeTab);
}

$$(".tabs button").forEach((button) => button.addEventListener("click", () => activate(button.dataset.tab)));
$("#theme").addEventListener("click", () => {
  state.theme = state.theme === "dark" ? "light" : "dark";
  save();
});

render();
