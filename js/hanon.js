// 하농 1번(The Virtuoso Pianist No.1) MusicXML 생성기.
// 오른손 C4, 왼손 C3에서 시작해 2옥타브 올라갔다 내려온다.

const STEP_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const UP = [0, 2, 3, 4, 5, 4, 3, 2];
const DOWN = [0, -2, -3, -4, -5, -4, -3, -2];
const BEAMS = ['begin', 'continue', 'continue', 'end'];

// 온음계 인덱스(0 = C0)를 음이름/옥타브로 바꾼다.
function pitchXml(index) {
  const step = STEP_NAMES[((index % 7) + 7) % 7];
  const octave = Math.floor(index / 7);
  return `<pitch><step>${step}</step><octave>${octave}</octave></pitch>`;
}

function sixteenths(start, pattern, voice, staff) {
  return pattern
    .map((offset, i) => {
      const beam = BEAMS[i % 4];
      return (
        `<note>${pitchXml(start + offset)}<duration>1</duration><voice>${voice}</voice>` +
        `<type>16th</type><staff>${staff}</staff>` +
        `<beam number="1">${beam}</beam><beam number="2">${beam}</beam></note>`
      );
    })
    .join('');
}

function halfNote(index, voice, staff) {
  return (
    `<note>${pitchXml(index)}<duration>8</duration><voice>${voice}</voice>` +
    `<type>half</type><staff>${staff}</staff></note>`
  );
}

export function buildHanon1() {
  const RH = 28; // C4
  const LH = 21; // C3
  const measures = [];

  for (let m = 0; m < 14; m++) measures.push({ offset: m, pattern: UP });
  for (let m = 0; m < 15; m++) measures.push({ offset: 18 - m, pattern: DOWN });

  const attributes =
    '<attributes><divisions>4</divisions><key><fifths>0</fifths></key>' +
    '<time><beats>2</beats><beat-type>4</beat-type></time><staves>2</staves>' +
    '<clef number="1"><sign>G</sign><line>2</line></clef>' +
    '<clef number="2"><sign>F</sign><line>4</line></clef></attributes>';

  let body = '';
  measures.forEach((m, i) => {
    body +=
      `<measure number="${i + 1}">${i === 0 ? attributes : ''}` +
      sixteenths(RH + m.offset, m.pattern, 1, 1) +
      '<backup><duration>8</duration></backup>' +
      sixteenths(LH + m.offset, m.pattern, 2, 2) +
      '</measure>';
  });
  body +=
    `<measure number="${measures.length + 1}">` +
    halfNote(RH, 1, 1) +
    '<backup><duration>8</duration></backup>' +
    halfNote(LH, 2, 2) +
    '<barline location="right"><bar-style>light-heavy</bar-style></barline></measure>';

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<score-partwise version="3.1">' +
    '<work><work-title>하농 1번</work-title></work>' +
    '<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>' +
    `<part id="P1">${body}</part>` +
    '</score-partwise>'
  );
}
