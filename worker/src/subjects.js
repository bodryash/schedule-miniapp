/**
 * Названия пар для сообщений бота — те же, что в приложении (docs/app.js,
 * shownSubject). ФИЯР: «2-ой Французский язык» с пометкой «МИР» — это не язык,
 * а свой предмет: «Мир Франции: история»; практика речи — «Французский язык:
 * практика речи». Держать в паре с приложением.
 */
const MIR_BY_TEACHER = {
  "msu-ffl": {
    "Бунтман Н.В.": "литература",
    "Ратникова Е.И.": "история",
    "Коваленко А.С.": "история",
    "Кузьмина Е.В.": "культура",
  },
};
const MIR_WORLDS = {
  Французский: "Мир Франции",
  Испанский: "Мир Испании",
  Итальянский: "Мир Италии",
  Немецкий: "Мир Германии",
  Китайский: "Мир Китая",
  Английский: "Мир англоязычных стран",
};

export function shownSubject(lesson, tenantId) {
  const lang = /^2-ой (\S+) язык$/.exec(lesson.subject || "");
  if (!lang) return lesson.subject;
  if (lesson.note === "МИР") {
    const byTeacher = MIR_BY_TEACHER[tenantId] || {};
    const hit = Object.keys(byTeacher).find((name) => String(lesson.teacher || "").includes(name));
    const world = MIR_WORLDS[lang[1]] || `Мир языка (${lang[1].toLowerCase()})`;
    return hit ? `${world}: ${byTeacher[hit]}` : world;
  }
  if (lesson.note === "теория и практика речевого общения") return `${lang[1]} язык: практика речи`;
  return lesson.subject;
}
