// Teo's Workout Planner: Phase 1 (MVP)
// Everything lives in this one file, split into numbered sections.
//
//  1. Database      (IndexedDB: where data is saved on the phone)
//  2. Data + state  (what's in memory, and "where was I?" for resuming)
//  3. Small helpers
//  4. Screens       (Home, Day editor, Exercise picker, Workout, Exercise pictures, Progress, Backup)
//  5. Click / input handling
//  6. Backup (export / import)
//  7. Startup

'use strict';

/* ============================================================
   1. DATABASE (IndexedDB)
   IndexedDB is the browser's built-in database. Its calls use
   "requests", so we wrap them in Promises to use async/await.
   ============================================================ */

const DB_NAME = 'teo-workout-planner';
const STORES = ['exercises', 'schedules', 'sessions', 'sets', 'appState'];
let db;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    // Runs the first time (creates the "tables"). Each has an "id" key.
    req.onupgradeneeded = () => {
      STORES.forEach((name) => req.result.createObjectStore(name, { keyPath: 'id' }));
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Turn one IndexedDB request into a Promise.
function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const dbGetAll = (store) => wrap(db.transaction(store).objectStore(store).getAll());
const dbGet = (store, id) => wrap(db.transaction(store).objectStore(store).get(id));

// Writes only count as SAVED when the whole transaction completes (not just when
// the request is accepted). Waiting for this means "await dbPut(...)" really
// guarantees the data is on disk before the app moves on.
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
function dbPut(store, obj) {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(obj);
  return txDone(tx);
}
function dbDelete(store, id) {
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(id);
  return txDone(tx);
}

/* ============================================================
   2. DATA + STATE
   `data` = copy of the database kept in memory (fast to draw from).
   Every change updates BOTH `data` and the database.
   `state` = where the user is. It's saved on every change, so
   reopening the app puts you back on the same exercise and set.
   ============================================================ */

const data = { exercises: [], schedule: null, sessions: [], sets: [] };

let state = {
  screen: 'home',      // 'home' | 'day' | 'picker' | 'workout' | 'viewer' | 'progress' | 'backup'
  dayId: null,         // day being edited / worked out
  progressDayId: null, // Progress screen: which day is picked
  progressExerciseId: null, // Progress screen: which exercise is picked
  viewerExerciseId: null,   // Pictures screen: which exercise is shown
  viewerReturn: 'home',     // ...and which screen "Close" goes back to ('picker' | 'workout')
  sessionId: null,     // workout in progress
  groupIndex: 0,       // which exercise (group) in the day
  setNumber: 1,        // which set of that exercise (1-based)
  draft: { reps: '10', weight: '0', unit: 'lbs' }, // numbers currently typed
};
let pickerSearch = '';
let pickerCreating = false;
let pickerFilters = new Set(); // muscle sections picked as filters in the picker (empty = show everything)
let colorPanelOpen = false;    // day editor: is the custom color picker (wheel + RGB) showing?
let colorHsv = { h: 0, s: 0, v: 1 }; // the color picker's current position: angle, distance from middle, brightness
let viewerScroll = 0; // how far down the page was before opening the pictures (so Close puts you back there)

// Exercise pictures. data/exercises.json (made by scripts/prepare-exercises.js) lists, for each
// built-in exercise, its image files. We look them up by exercise name (ignoring capitals).
const exerciseImages = new Map(); // lowercase name -> ['Folder/0.jpg', 'Folder/1.jpg']

async function loadExerciseImages() {
  try {
    const list = await (await fetch('data/exercises.json')).json();
    for (const e of list) exerciseImages.set(e.name.toLowerCase(), e.images);
  } catch (err) {
    console.error('Could not load exercise pictures', err); // the app still works, just without pictures
  }
}
const imagesFor = (ex) => (ex && exerciseImages.get(ex.name.toLowerCase())) || [];

async function saveState() {
  await dbPut('appState', { id: 'main', ...state });
}

// The built-in exercise list, so the picker isn't empty. Teo can add custom ones.
// Format: [name, muscle groups, equipment]. The "// ---" comments are section
// headings. listed_exercises.md is a readable copy of this list: keep them in sync.
const STARTER_EXERCISES = [
  // --- Chest ---
  ['Barbell Bench Press - Medium Grip', 'Chest, Triceps', 'Barbell'],
  ['Barbell Incline Bench Press - Medium Grip', 'Chest, Shoulders', 'Barbell'],
  ['Decline Barbell Bench Press', 'Chest, Triceps', 'Barbell'],
  ['Dumbbell Bench Press', 'Chest, Triceps', 'Dumbbells'],
  ['Incline Dumbbell Press', 'Chest, Shoulders', 'Dumbbells'],
  ['Leverage Chest Press', 'Chest, Triceps', 'Machine'],
  ['Dumbbell Flyes', 'Chest', 'Dumbbells'],
  ['Cable Crossover', 'Chest', 'Cable'],
  ['Butterfly', 'Chest', 'Machine'],
  ['Pushups', 'Chest, Triceps', 'Bodyweight'],
  ['Dips - Chest Version', 'Chest, Triceps', 'Bodyweight'],
  // --- Back ---
  ['Pullups', 'Back, Biceps', 'Bodyweight'],
  ['Chin-Up', 'Back, Biceps', 'Bodyweight'],
  ['Wide-Grip Lat Pulldown', 'Back, Biceps', 'Cable'],
  ['Close-Grip Front Lat Pulldown', 'Back, Biceps', 'Cable'],
  ['Straight-Arm Pulldown', 'Back', 'Cable'],
  ['Bent Over Barbell Row', 'Back', 'Barbell'],
  ['T-Bar Row with Handle', 'Back', 'Barbell'],
  ['One-Arm Dumbbell Row', 'Back, Biceps', 'Dumbbells'],
  ['Seated Cable Rows', 'Back', 'Cable'],
  ['Leverage Iso Row', 'Back', 'Machine'],
  ['Inverted Row', 'Back, Biceps', 'Bodyweight'],
  ['Barbell Deadlift', 'Back, Hamstrings, Glutes', 'Barbell'],
  ['Hyperextensions (Back Extensions)', 'Lower back, Glutes', 'Bodyweight'],
  // --- Shoulders ---
  ['Barbell Shoulder Press', 'Shoulders, Triceps', 'Barbell'],
  ['Dumbbell Shoulder Press', 'Shoulders, Triceps', 'Dumbbells'],
  ['Arnold Dumbbell Press', 'Shoulders', 'Dumbbells'],
  ['Machine Shoulder (Military) Press', 'Shoulders, Triceps', 'Machine'],
  ['Side Lateral Raise', 'Shoulders', 'Dumbbells'],
  ['Cable Seated Lateral Raise', 'Shoulders', 'Cable'],
  ['Front Dumbbell Raise', 'Shoulders', 'Dumbbells'],
  ['Reverse Flyes', 'Rear delts, Upper back', 'Dumbbells'],
  ['Face Pull', 'Rear delts, Upper back', 'Cable'],
  ['Upright Barbell Row', 'Shoulders, Traps', 'Barbell'],
  ['Barbell Shrug', 'Traps', 'Barbell'],
  ['Dumbbell Shrug', 'Traps', 'Dumbbells'],
  // --- Biceps and forearms ---
  ['Barbell Curl', 'Biceps', 'Barbell'],
  ['EZ-Bar Curl', 'Biceps', 'Barbell'],
  ['Dumbbell Bicep Curl', 'Biceps', 'Dumbbells'],
  ['Incline Dumbbell Curl', 'Biceps', 'Dumbbells'],
  ['Hammer Curls', 'Biceps, Forearms', 'Dumbbells'],
  ['Preacher Curl', 'Biceps', 'Barbell'],
  ['Concentration Curls', 'Biceps', 'Dumbbells'],
  ['Standing Biceps Cable Curl', 'Biceps', 'Cable'],
  ['Reverse Barbell Curl', 'Forearms, Biceps', 'Barbell'],
  ['Seated Dumbbell Palms-Up Wrist Curl', 'Forearms', 'Dumbbells'],
  // --- Triceps ---
  ['Triceps Pushdown', 'Triceps', 'Cable'],
  ['Standing Dumbbell Triceps Extension', 'Triceps', 'Dumbbells'],
  ['EZ-Bar Skullcrusher', 'Triceps', 'EZ bar'],
  ['Close-Grip Barbell Bench Press', 'Triceps, Chest', 'Barbell'],
  ['Bench Dips', 'Triceps', 'Bodyweight'],
  ['Tricep Dumbbell Kickback', 'Triceps', 'Dumbbells'],
  ['Push-Ups - Close Triceps Position', 'Triceps, Chest', 'Bodyweight'],
  // --- Legs ---
  ['Barbell Squat', 'Quads, Glutes', 'Barbell'],
  ['Front Barbell Squat', 'Quads, Core', 'Barbell'],
  ['Goblet Squat', 'Quads, Glutes', 'Dumbbells'],
  ['Hack Squat', 'Quads, Glutes', 'Machine'],
  ['Leg Press', 'Quads, Glutes', 'Machine'],
  ['Split Squat with Dumbbells', 'Quads, Glutes', 'Dumbbells'],
  ['Dumbbell Lunges', 'Quads, Glutes', 'Dumbbells'],
  ['Dumbbell Rear Lunge', 'Quads, Glutes', 'Dumbbells'],
  ['Dumbbell Step Ups', 'Quads, Glutes', 'Dumbbells'],
  ['Leg Extensions', 'Quads', 'Machine'],
  ['Romanian Deadlift', 'Hamstrings, Glutes', 'Barbell'],
  ['Stiff-Legged Barbell Deadlift', 'Hamstrings, Lower back', 'Barbell'],
  ['Sumo Deadlift', 'Glutes, Hamstrings, Quads', 'Barbell'],
  ['Good Morning', 'Hamstrings, Lower back', 'Barbell'],
  ['Lying Leg Curls', 'Hamstrings', 'Machine'],
  ['Seated Leg Curl', 'Hamstrings', 'Machine'],
  ['Barbell Hip Thrust', 'Glutes, Hamstrings', 'Barbell'],
  ['Butt Lift (Bridge)', 'Glutes, Hamstrings', 'Bodyweight'],
  ['Pull Through', 'Glutes, Hamstrings', 'Cable'],
  ['One-Legged Cable Kickback', 'Glutes', 'Cable'],
  ['Thigh Abductor', 'Glutes', 'Machine'],
  ['Thigh Adductor', 'Inner thighs', 'Machine'],
  ['Standing Calf Raises', 'Calves', 'Machine'],
  ['Seated Calf Raise', 'Calves', 'Machine'],
  // --- Core ---
  ['Plank', 'Core', 'Bodyweight'],
  ['Side Bridge', 'Core, Obliques', 'Bodyweight'],
  ['Crunches', 'Core', 'Bodyweight'],
  ['Sit-Up', 'Core', 'Bodyweight'],
  ['Air Bike', 'Core, Obliques', 'Bodyweight'],
  ['Cable Crunch', 'Core', 'Cable'],
  ['Hanging Leg Raise', 'Core, Hip flexors', 'Bodyweight'],
  ['Russian Twist', 'Core, Obliques', 'Bodyweight'],
  ['Ab Roller', 'Core', 'Ab wheel'],
  ['Dead Bug', 'Core', 'Bodyweight'],
  ['Mountain Climbers', 'Core, Shoulders', 'Bodyweight'],
  // --- Full body ---
  ['One-Arm Kettlebell Swings', 'Glutes, Hamstrings, Core', 'Kettlebell'],
  ["Farmer's Walk", 'Forearms, Traps, Core', 'Dumbbells'],
];

// Older versions of the app used different names. The exercise pictures are found by
// exact name, so the names now match the free-exercise-db dataset. This map lets
// loadData() rename exercises already saved on a device (same id, so your logged
// history and your days keep working). Old name (lowercase) -> new name.
const RENAMED_EXERCISES = {
  'barbell bench press': 'Barbell Bench Press - Medium Grip',
  'incline barbell bench press': 'Barbell Incline Bench Press - Medium Grip',
  'decline bench press': 'Decline Barbell Bench Press',
  'machine chest press': 'Leverage Chest Press',
  'dumbbell fly': 'Dumbbell Flyes',
  'pec deck': 'Butterfly',
  'push-up': 'Pushups',
  'chest dip': 'Dips - Chest Version',
  'pull-up': 'Pullups',
  'lat pulldown': 'Wide-Grip Lat Pulldown',
  'close-grip lat pulldown': 'Close-Grip Front Lat Pulldown',
  'barbell row': 'Bent Over Barbell Row',
  't-bar row': 'T-Bar Row with Handle',
  'seated cable row': 'Seated Cable Rows',
  'machine row': 'Leverage Iso Row',
  'deadlift': 'Barbell Deadlift',
  'back extension': 'Hyperextensions (Back Extensions)',
  'overhead press': 'Barbell Shoulder Press',
  'arnold press': 'Arnold Dumbbell Press',
  'machine shoulder press': 'Machine Shoulder (Military) Press',
  'lateral raise': 'Side Lateral Raise',
  'cable lateral raise': 'Cable Seated Lateral Raise',
  'front raise': 'Front Dumbbell Raise',
  'rear delt fly': 'Reverse Flyes',
  'upright row': 'Upright Barbell Row',
  'dumbbell curl': 'Dumbbell Bicep Curl',
  'hammer curl': 'Hammer Curls',
  'concentration curl': 'Concentration Curls',
  'cable curl': 'Standing Biceps Cable Curl',
  'reverse curl': 'Reverse Barbell Curl',
  'wrist curl': 'Seated Dumbbell Palms-Up Wrist Curl',
  'tricep pushdown': 'Triceps Pushdown',
  'overhead tricep extension': 'Standing Dumbbell Triceps Extension',
  'skull crusher': 'EZ-Bar Skullcrusher',
  'close-grip bench press': 'Close-Grip Barbell Bench Press',
  'bench dip': 'Bench Dips',
  'tricep kickback': 'Tricep Dumbbell Kickback',
  'diamond push-up': 'Push-Ups - Close Triceps Position',
  'front squat': 'Front Barbell Squat',
  'bulgarian split squat': 'Split Squat with Dumbbells',
  'walking lunge': 'Dumbbell Lunges',
  'reverse lunge': 'Dumbbell Rear Lunge',
  'step-up': 'Dumbbell Step Ups',
  'leg extension': 'Leg Extensions',
  'stiff-leg deadlift': 'Stiff-Legged Barbell Deadlift',
  'leg curl': 'Lying Leg Curls',
  'hip thrust': 'Barbell Hip Thrust',
  'glute bridge': 'Butt Lift (Bridge)',
  'cable pull-through': 'Pull Through',
  'cable glute kickback': 'One-Legged Cable Kickback',
  'hip abduction machine': 'Thigh Abductor',
  'hip adduction machine': 'Thigh Adductor',
  'standing calf raise': 'Standing Calf Raises',
  'side plank': 'Side Bridge',
  'crunch': 'Crunches',
  'bicycle crunch': 'Air Bike',
  'ab wheel rollout': 'Ab Roller',
  'mountain climber': 'Mountain Climbers',
  'kettlebell swing': 'One-Arm Kettlebell Swings',
};


function makeExercise(name, muscles, equipment, isCustom) {
  return {
    id: uid(), name, muscleGroups: muscles.split(',').map((m) => m.trim()).filter(Boolean),
    equipment, notes: '', scienceTips: '', mediaLink: '', defaultUnit: 'lbs', isCustom,
  };
}

// Load everything from the database. Also adds any starter exercises that are
// missing (first run, or after the list above got new ones) and, on the very
// first run, the one main schedule.
async function loadData() {
  data.exercises = await dbGetAll('exercises');
  data.sessions = await dbGetAll('sessions');
  data.sets = await dbGetAll('sets');
  const schedules = await dbGetAll('schedules');

  // Give exercises saved under an OLD built-in name their new name (custom ones are left alone).
  for (const ex of data.exercises) {
    const newName = !ex.isCustom && RENAMED_EXERCISES[ex.name.toLowerCase()];
    if (newName) {
      ex.name = newName;
      await dbPut('exercises', ex);
    }
  }

  // Matching by name (ignoring capitals) means existing and custom exercises are never duplicated or changed.
  const have = new Set(data.exercises.map((e) => e.name.toLowerCase()));
  for (const [n, m, e] of STARTER_EXERCISES) {
    if (have.has(n.toLowerCase())) continue;
    const ex = makeExercise(n, m, e, false);
    data.exercises.push(ex);
    await dbPut('exercises', ex);
  }
  if (schedules.length === 0) {
    const schedule = { id: uid(), name: 'My Schedule', repeat: 'weekly', days: [], isMain: true };
    await dbPut('schedules', schedule);
    schedules.push(schedule);
  }
  data.schedule = schedules.find((s) => s.isMain) || schedules[0];
}

const saveSchedule = () => dbPut('schedules', data.schedule);

/* ============================================================
   3. SMALL HELPERS
   ============================================================ */

const $app = document.getElementById('app');
const DAY_COLORS = [
  '#e63946', '#e76f51', '#f4a261', '#f7c948', '#2ecc71', '#2a9d8f',
  '#00b4d8', '#457b9d', '#3f51b5', '#8d5fd3', '#e75480', '#8d6e63',
];
const WEEKDAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']];

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Escape user-typed text before putting it into HTML (stops broken/unsafe markup).
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2500);
}

const getDay = (id) => data.schedule.days.find((d) => d.id === id);
const getExercise = (id) => data.exercises.find((e) => e.id === id);
const getSession = (id) => data.sessions.find((s) => s.id === id);
const unfinishedSession = () => data.sessions.find((s) => !s.finished);
const setsFor = (sessionId, exerciseId) =>
  data.sets.filter((s) => s.sessionId === sessionId && s.exerciseId === exerciseId);

// Change screen, save where we are, redraw.
function go(screen, extra = {}) {
  Object.assign(state, extra, { screen });
  saveState();
  render();
  window.scrollTo(0, 0);
}

/* ---- Workout helpers ---- */

// The most recent set logged for an exercise in an OLDER workout ("last time").
function lastTimeSet(exerciseId, sessionId, setNumber) {
  const older = data.sets
    .filter((s) => s.exerciseId === exerciseId && s.sessionId !== sessionId)
    .sort((a, b) => b.timestamp - a.timestamp);
  return older.find((s) => s.setNumber === setNumber) || older[0] || null;
}

// Fill the reps/weight boxes: use last time's numbers, else the last set this workout.
function loadDraft() {
  const day = getDay(state.dayId);
  const group = day && day.groups[state.groupIndex];
  if (!group) return;
  const exId = group.exerciseIds[0];
  const ex = getExercise(exId);
  const mine = setsFor(state.sessionId, exId).sort((a, b) => b.timestamp - a.timestamp)[0];
  // Last time's numbers for this set come first; else what I just logged this workout.
  const src = lastTimeSet(exId, state.sessionId, state.setNumber) || mine;
  state.draft = src
    ? { reps: String(src.reps), weight: String(src.weight), unit: src.unit }
    : { reps: '10', weight: '0', unit: (ex && ex.defaultUnit) || 'lbs' };
}

// Jump to an exercise, landing on its next unlogged set.
function gotoGroup(index) {
  const day = getDay(state.dayId);
  const group = day.groups[index];
  state.groupIndex = index;
  // Land on the next unlogged set (never past the planned sets: no extra sets).
  state.setNumber = Math.min(setsFor(state.sessionId, group.exerciseIds[0]).length + 1, group.plannedSets);
  loadDraft();
  saveState();
  render();
}

/* ---- Exercise sections (by muscle) and search ---- */

// The picker lists exercises in these sections, in this order.
const SECTION_ORDER = ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Forearms', 'Quads', 'Hamstrings', 'Glutes', 'Calves', 'Core', 'Full body', 'Other'];

// Which section a muscle belongs to. An exercise goes in the section of the FIRST
// muscle in its list that is known here (so custom exercises sort themselves too).
const MUSCLE_SECTION = {
  'chest': 'Chest', 'pecs': 'Chest', 'pectorals': 'Chest',
  'back': 'Back', 'lats': 'Back', 'upper back': 'Back', 'middle back': 'Back', 'lower back': 'Back',
  'shoulders': 'Shoulders', 'delts': 'Shoulders', 'rear delts': 'Shoulders', 'front delts': 'Shoulders', 'traps': 'Shoulders', 'trapezius': 'Shoulders',
  'biceps': 'Biceps', 'triceps': 'Triceps', 'forearms': 'Forearms',
  'quads': 'Quads', 'quadriceps': 'Quads', 'hamstrings': 'Hamstrings',
  'glutes': 'Glutes', 'inner thighs': 'Glutes', 'hip flexors': 'Glutes', 'calves': 'Calves',
  'core': 'Core', 'abs': 'Core', 'abdominals': 'Core', 'obliques': 'Core', 'full body': 'Full body',
};
function sectionOf(ex) {
  for (const muscle of ex.muscleGroups) {
    const section = MUSCLE_SECTION[muscle.trim().toLowerCase()];
    if (section) return section;
  }
  return 'Other';
}

// Everyday words people type for each section, so "abs" finds core exercises, "pecs" finds chest...
const SECTION_WORDS = {
  Chest: 'chest pecs pectorals', Back: 'back lats', Shoulders: 'shoulders delts deltoids traps',
  Biceps: 'biceps arms', Triceps: 'triceps arms', Forearms: 'forearms grip',
  Quads: 'quads quadriceps legs thighs', Hamstrings: 'hamstrings hams legs', Glutes: 'glutes butt hips legs',
  Calves: 'calves legs', Core: 'core abs abdominals stomach obliques', 'Full body': 'full body',
};

// Other names for built-in exercises (the key is the exercise name in lowercase).
// The old app names (see RENAMED_EXERCISES) are added automatically.
const EXERCISE_ALIASES = {
  'pushups': 'push up press up',
  'pullups': 'pull up chin up',
  'chin-up': 'chin up chinup',
  'dips - chest version': 'dip dips parallel bar dip',
  'barbell bench press - medium grip': 'bench press flat bench',
  'barbell incline bench press - medium grip': 'incline bench press incline bench',
  'dumbbell bench press': 'db bench press',
  'incline dumbbell press': 'incline db press',
  'dumbbell flyes': 'dumbbell fly db fly chest fly',
  'butterfly': 'pec deck pec fly machine fly chest fly',
  'cable crossover': 'cable fly cable flye chest fly',
  'wide-grip lat pulldown': 'lat pulldown pulldown lat pull down',
  'bent over barbell row': 'barbell row bent over row bb row',
  'barbell deadlift': 'deadlift dead lift conventional deadlift',
  'hyperextensions (back extensions)': 'back extension hyperextension hypers',
  'barbell shoulder press': 'overhead press ohp military press shoulder press standing press',
  'dumbbell shoulder press': 'db shoulder press overhead press',
  'side lateral raise': 'lateral raise side raise lat raise side delt raise',
  'reverse flyes': 'rear delt fly rear delt raise reverse fly',
  'face pull': 'face pulls rear delt',
  'upright barbell row': 'upright row',
  'barbell curl': 'bicep curl biceps curl bb curl',
  'dumbbell bicep curl': 'dumbbell curl db curl bicep curl biceps curl',
  'ez-bar curl': 'ez curl ez bar curl',
  'hammer curls': 'hammer curl',
  'triceps pushdown': 'tricep pushdown pushdown pressdown rope pushdown',
  'ez-bar skullcrusher': 'skull crusher skullcrushers lying tricep extension french press',
  'close-grip barbell bench press': 'close grip bench cgbp',
  'bench dips': 'bench dip tricep dip',
  'tricep dumbbell kickback': 'tricep kickback kickbacks',
  'standing dumbbell triceps extension': 'overhead tricep extension overhead triceps',
  'barbell squat': 'squat back squat squats',
  'front barbell squat': 'front squat',
  'split squat with dumbbells': 'bulgarian split squat',
  'dumbbell lunges': 'walking lunge lunge lunges',
  'dumbbell rear lunge': 'reverse lunge rear lunge',
  'dumbbell step ups': 'step up',
  'leg extensions': 'leg extension quad extension',
  'lying leg curls': 'leg curl hamstring curl',
  'seated leg curl': 'hamstring curl',
  'romanian deadlift': 'rdl',
  'stiff-legged barbell deadlift': 'stiff leg deadlift sldl',
  'barbell hip thrust': 'hip thrust glute thrust',
  'butt lift (bridge)': 'glute bridge hip bridge',
  'pull through': 'cable pull through',
  'one-legged cable kickback': 'cable glute kickback glute kickback',
  'thigh abductor': 'hip abduction abductor machine',
  'thigh adductor': 'hip adduction adductor machine',
  'standing calf raises': 'calf raise standing calf raise',
  'seated calf raise': 'calf raise',
  'side bridge': 'side plank',
  'crunches': 'crunch ab crunch',
  'sit-up': 'situp sit up',
  'air bike': 'bicycle crunch bicycle crunches',
  'ab roller': 'ab wheel ab wheel rollout rollout',
  'mountain climbers': 'mountain climber',
  'one-arm kettlebell swings': 'kettlebell swing kb swing',
  "farmer's walk": 'farmers walk farmer carry farmers carry',
};
const OLD_NAMES = {}; // new name (lowercase) -> old name
for (const [oldName, newName] of Object.entries(RENAMED_EXERCISES)) OLD_NAMES[newName.toLowerCase()] = oldName;

// Lowercase, and turn every dash / bracket / symbol into a space ("Pull-Up (wide)" -> "pull up wide").
const plainText = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Does this exercise match what was typed? Looks at the name, other names, muscles,
// equipment and the section's everyday words. Word order doesn't matter, "curls" finds
// "curl", and "pullup" / "pull up" / "pull-up" are all the same.
function exerciseMatches(ex, query, allowTypos = false) {
  const q = plainText(query);
  if (!q) return true;
  const key = ex.name.toLowerCase();
  const haystack = plainText([
    ex.name, EXERCISE_ALIASES[key], OLD_NAMES[key], ex.muscleGroups.join(' '), ex.equipment, SECTION_WORDS[sectionOf(ex)],
  ].join(' '));
  if (haystack.replace(/ /g, '').includes(q.replace(/ /g, ''))) return true; // ignores spaces: "pushup" = "push up"
  const words = haystack.split(' ');
  return q.split(' ').every((w) => words.some((word) =>
    word.startsWith(w) || (w.length > 3 && w.endsWith('s') && word === w.slice(0, -1)) ||
    (allowTypos && isTypoOf(w, word))));
}

// Is `typed` one letter off (wrong, missing or extra) from the start of `word`? Catches "dumbell" for "dumbbell".
function isTypoOf(typed, word) {
  if (typed.length < 4) return false; // too short to guess safely
  return [-1, 0, 1].some((extra) => oneEditAway(typed, word.slice(0, typed.length + extra)));
}
function oneEditAway(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++; // skip the matching start
  if (i === a.length && i === b.length) return true;           // identical
  const rest = (str, from) => str.slice(from);
  return rest(a, i + 1) === rest(b, i + 1) ||   // one letter different
         rest(a, i + 1) === rest(b, i) ||       // one extra letter in a
         rest(a, i) === rest(b, i + 1);         // one letter missing from a
}

/* ---- Color helpers (for the day color picker) ---- */
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0x1d3557;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

// h = 0-360 (the angle around the wheel), s = 0-1 (distance from the middle), v = 0-1 (brightness)
function hsvToRgb(h, s, v) {
  const channel = (n) => {
    const k = (n + h / 60) % 6;
    return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255;
  };
  return [channel(5), channel(3), channel(1)];
}
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), diff = max - Math.min(r, g, b);
  let h = 0;
  if (diff) {
    if (max === r) h = ((g - b) / diff) % 6;
    else if (max === g) h = (b - r) / diff + 2;
    else h = (r - g) / diff + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? diff / max : 0, v: max };
}

/* ============================================================
   4. SCREENS
   Each function returns HTML text. render() picks the right one.
   Buttons use data-action="..." (handled in section 5).
   ============================================================ */

function render() {
  const screens = { home: homeScreen, day: dayScreen, picker: pickerScreen, workout: workoutScreen, viewer: viewerScreen, progress: progressScreen, backup: backupScreen };
  // If saved state points at something that no longer exists, fall back to home.
  const session = getSession(state.sessionId);
  if (state.screen === 'workout' && !(session && !session.finished && getDay(state.dayId))) state.screen = 'home';
  if ((state.screen === 'day' || state.screen === 'picker') && !getDay(state.dayId)) state.screen = 'home';
  if (state.screen === 'progress') fixProgressPicks();
  if (state.screen === 'viewer' && !getExercise(state.viewerExerciseId)) state.screen = 'home';
  // If an exercise was removed mid-workout, keep the position inside the list.
  if (state.screen === 'workout') {
    state.groupIndex = Math.max(0, Math.min(state.groupIndex, getDay(state.dayId).groups.length - 1));
  }
  $app.innerHTML = screens[state.screen]();
  // The color wheel is a <canvas>, so it has to be painted after the page is drawn.
  if (state.screen === 'day' && colorPanelOpen) setupColorPanel();
}

/* ---------- Home ---------- */
function homeScreen() {
  const today = String(new Date().getDay());
  const open = unfinishedSession();
  const openDay = open && getDay(open.dayId);

  const banner = openDay
    ? `<button class="banner" data-action="resume">Resume workout: ${esc(openDay.name)}</button>` : '';

  const cards = data.schedule.days.map((day) => {
    const isToday = day.weekday === today;
    const weekday = WEEKDAYS.find(([v]) => v === day.weekday);
    return `
      <div class="card day-card ${isToday ? 'today' : ''}" style="--day-color:${day.color}">
        <h2>${esc(day.name)}${isToday ? '<span class="badge">Today</span>' : ''}</h2>
        <p class="muted">${day.groups.length} exercise${day.groups.length === 1 ? '' : 's'}${weekday ? ' · ' + weekday[1] : ''}</p>
        <div class="row">
          <button class="primary" data-action="start-workout" data-id="${day.id}">Start</button>
          <button data-action="edit-day" data-id="${day.id}">Edit</button>
        </div>
      </div>`;
  }).join('');

  return `
    <h1>Teo's Workout Planner</h1>
    ${banner}
    ${cards || '<div class="card"><p>No workout days yet. Add your first one below (like "Push Day").</p></div>'}
    <button class="block" data-action="add-day">＋ Add a day</button>
    <button class="block" data-action="open-progress">Progress</button>
    <button class="block" data-action="open-backup">Backup &amp; restore</button>`;
}

/* ---------- Day editor ---------- */
function dayScreen() {
  const day = getDay(state.dayId);
  const rows = day.groups.map((g, i) => {
    const ex = getExercise(g.exerciseIds[0]);
    return `
      <div class="card ex-row">
        <div class="ex-head">
          <div class="name">${esc(ex ? ex.name : '(missing exercise)')}</div>
          ${imagesFor(ex).length ? `<button class="small" data-action="view-exercise" data-id="${ex.id}">View</button>` : ''}
        </div>
        <div class="stepper">
          <button class="small" data-action="sets-minus" data-index="${i}">−</button>
          <span class="val">${g.plannedSets} sets</span>
          <button class="small" data-action="sets-plus" data-index="${i}">＋</button>
        </div>
        <span class="spacer"></span>
        <button class="small" data-action="move-up" data-index="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="small" data-action="move-down" data-index="${i}" ${i === day.groups.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="small danger" data-action="remove-group" data-index="${i}">✕</button>
      </div>`;
  }).join('');

  // Preset colors + a rainbow swatch that opens the custom color picker.
  const swatches = DAY_COLORS.map((c) =>
    `<button class="swatch ${c === day.color ? 'selected' : ''}" style="background:${c}" data-action="set-color" data-color="${c}" aria-label="Color ${c}"></button>`
  ).join('') +
    `<button class="swatch rainbow ${colorPanelOpen || !DAY_COLORS.includes(day.color) ? 'selected' : ''}" data-action="toggle-color-panel" aria-label="Custom color"></button>`;
  const [red, green, blue] = hexToRgb(day.color);
  const colorPanel = colorPanelOpen ? `
      <div class="color-panel">
        <div class="wheel-wrap">
          <canvas class="wheel" width="440" height="440"></canvas>
          <div class="wheel-dark"></div>
          <div class="wheel-marker"></div>
        </div>
        <label for="color-v">Brightness</label>
        <input type="range" id="color-v" data-field="color-v" min="0" max="100" value="${Math.round(colorHsv.v * 100)}">
        <div class="rgb-row">
          <div><label for="rgb-r">R</label><input type="number" id="rgb-r" data-field="rgb-r" min="0" max="255" inputmode="numeric" value="${red}"></div>
          <div><label for="rgb-g">G</label><input type="number" id="rgb-g" data-field="rgb-g" min="0" max="255" inputmode="numeric" value="${green}"></div>
          <div><label for="rgb-b">B</label><input type="number" id="rgb-b" data-field="rgb-b" min="0" max="255" inputmode="numeric" value="${blue}"></div>
          <div class="color-preview" style="background:${day.color}" aria-label="Chosen color"></div>
        </div>
      </div>` : '';

  const weekdayOptions = [['', 'No specific day'], ...WEEKDAYS.map(([v, n]) => [v, n])]
    .map(([v, n]) => `<option value="${v}" ${day.weekday === v ? 'selected' : ''}>${n}</option>`).join('');

  return `
    <div class="topbar">
      <button data-action="go-home">‹ Home</button>
      <span class="title">Edit day</span>
      <span style="width:80px"></span>
    </div>
    <div class="card">
      <label for="day-name">Day name</label>
      <input type="text" id="day-name" data-field="day-name" value="${esc(day.name)}">
      <label>Color</label>
      <div class="swatches">${swatches}</div>
      ${colorPanel}
      <label for="day-weekday">Weekday (highlights it as "Today")</label>
      <select id="day-weekday" data-field="day-weekday">${weekdayOptions}</select>
    </div>
    <h3>Exercises</h3>
    ${rows || '<p class="muted">No exercises yet. Tap the button below.</p>'}
    <button class="block" data-action="open-picker">＋ Add exercise</button>
    <button class="primary block" data-action="save-day">✓ Save day</button>
    <button class="danger block" data-action="delete-day">Delete this day</button>`;
}

/* ---------- Exercise picker ---------- */
function pickerScreen() {
  if (pickerCreating) {
    return `
      <div class="topbar">
        <button data-action="picker-back-list">‹ Back</button>
        <span class="title">New exercise</span>
        <span style="width:80px"></span>
      </div>
      <div class="card">
        <label for="new-name">Name</label>
        <input type="text" id="new-name" placeholder="e.g. Cable Crunch">
        <label for="new-muscles">Muscle groups (comma separated)</label>
        <input type="text" id="new-muscles" placeholder="e.g. Core">
        <label for="new-notes">Notes (optional)</label>
        <textarea id="new-notes" placeholder="Cues, rest time, seat setting..."></textarea>
        <label for="new-unit">Default unit</label>
        <select id="new-unit"><option>lbs</option><option>kg</option></select>
      </div>
      <button class="primary block" data-action="save-custom">Save &amp; add to day</button>`;
  }
  return `
    <div class="topbar">
      <button data-action="close-picker">‹ Back</button>
      <span class="title">Add exercise</span>
      <span style="width:80px"></span>
    </div>
    <input type="search" id="picker-search" data-field="picker-search" placeholder="Search by name, muscle or equipment" value="${esc(pickerSearch)}">
    <button class="block" data-action="new-custom">＋ Create custom exercise</button>
    <label>Show only (tap again to clear)</label>
    <div class="chips">${pickerFilterChips()}</div>
    <div id="picker-list">${pickerListHtml()}</div>`;
}

// One chip per muscle section that has exercises. Tapping toggles it; none selected = show all.
function pickerFilterChips() {
  const present = new Set(data.exercises.map(sectionOf));
  return SECTION_ORDER.filter((name) => present.has(name)).map((name) =>
    `<button class="chip ${pickerFilters.has(name) ? 'selected' : ''}" data-action="picker-filter" data-section="${name}">${name}</button>`).join('');
}

// Just the list part, so typing in the search box doesn't redraw the box itself.
// Exercises are grouped under a heading per muscle section, A to Z inside each section.
function pickerListHtml() {
  const inFilter = (e) => pickerFilters.size === 0 || pickerFilters.has(sectionOf(e));
  let wanted = data.exercises.filter((e) => inFilter(e) && exerciseMatches(e, pickerSearch));
  // Nothing found? Try again forgiving small typos ("dumbell", "tricpes").
  if (!wanted.length) wanted = data.exercises.filter((e) => inFilter(e) && exerciseMatches(e, pickerSearch, true));
  // Each row = the exercise (tap to add it) + a "View" button on the right (only if it has pictures).
  const row = (e) => `
    <div class="pick-row">
      <button class="pick-item" data-action="pick-exercise" data-id="${e.id}">
        <strong>${esc(e.name)}</strong>
        <span class="muted">${esc(e.muscleGroups.join(', '))}${e.isCustom ? ' · custom' : ''}</span>
      </button>
      ${imagesFor(e).length ? `<button class="pick-view" data-action="view-exercise" data-id="${e.id}">View</button>` : ''}
    </div>`;
  return SECTION_ORDER.map((name) => {
    const inSection = wanted.filter((e) => sectionOf(e) === name).sort((a, b) => a.name.localeCompare(b.name));
    return inSection.length ? `<h3>${name}</h3>${inSection.map(row).join('')}` : '';
  }).join('') || '<p class="muted">No match. Try different words, or "Create custom exercise".</p>';
}

/* ---------- Workout (logging) ---------- */
function workoutScreen() {
  const day = getDay(state.dayId);
  const groups = day.groups;
  if (groups.length === 0) return `<p>This day has no exercises.</p><button data-action="go-home">‹ Home</button>`;

  const group = groups[state.groupIndex];
  const ex = getExercise(group.exerciseIds[0]);
  const done = setsFor(state.sessionId, ex.id).sort((a, b) => a.setNumber - b.setNumber);
  const planned = group.plannedSets;
  const last = lastTimeSet(ex.id, state.sessionId, state.setNumber);
  const session = getSession(state.sessionId);

  // Progress dots: one per exercise
  const dots = groups.map((g, i) => {
    const n = setsFor(state.sessionId, g.exerciseIds[0]).length;
    const cls = i === state.groupIndex ? 'current' : n >= g.plannedSets ? 'done' : '';
    return `<span class="dot ${cls}"></span>`;
  }).join('');

  const d = state.draft;
  const setText = `Set ${state.setNumber} of ${planned}`;
  // On the very last set of the very last exercise, the button finishes the workout.
  const isLastSet = state.groupIndex === groups.length - 1 && state.setNumber >= planned;

  return `
    <div class="topbar">
      <button data-action="go-home">‹ Home</button>
      <span class="title">${esc(day.name)}</span>
      <button class="primary" data-action="finish">Finish</button>
    </div>
    <div class="dots">${dots}</div>

    <div class="card">
      <h2>${esc(ex.name)}</h2>
      <p class="set-label">${setText}</p>
      <p class="hint">${last ? `Last time: ${last.weight} ${last.unit} × ${last.reps}` : 'No previous numbers yet'}</p>
      ${ex.notes ? `<p class="muted">Notes: ${esc(ex.notes)}</p>` : ''}
      ${imagesFor(ex).length ? `<button class="block" data-action="view-exercise" data-id="${ex.id}">View exercise</button>` : ''}

      <label>Weight (${esc(d.unit)})</label>
      <div class="num-field">
        <button data-action="bump" data-field="weight" data-delta="-2.5">−</button>
        <input id="weight" data-field="weight" inputmode="decimal" value="${esc(d.weight)}">
        <button data-action="bump" data-field="weight" data-delta="2.5">＋</button>
      </div>

      <div class="unit-toggle">
        <button data-action="set-unit" data-unit="lbs" class="${d.unit === 'lbs' ? 'selected' : ''}">lbs</button>
        <button data-action="set-unit" data-unit="kg" class="${d.unit === 'kg' ? 'selected' : ''}">kg</button>
      </div>

      <label>Reps</label>
      <div class="num-field">
        <button data-action="bump" data-field="reps" data-delta="-1">−</button>
        <input id="reps" data-field="reps" inputmode="numeric" pattern="[0-9]*" value="${esc(d.reps)}">
        <button data-action="bump" data-field="reps" data-delta="1">＋</button>
      </div>

      <button class="primary big" data-action="set-done">${isLastSet ? 'Finish workout ✓' : 'Set done ✓'}</button>
      <button class="block" data-action="undo" ${data.sets.some((s) => s.sessionId === state.sessionId) ? '' : 'disabled'}>↶ Undo last set</button>

      ${done.length ? `<div class="logged"><p class="muted">Logged today:</p>${
        done.map((s) => `<span>${s.setNumber}: ${s.weight} ${s.unit} × ${s.reps}</span>`).join('')}</div>` : ''}
    </div>

    <div class="nav-row">
      <button data-action="prev-group" ${state.groupIndex === 0 ? 'disabled' : ''}>← Previous</button>
      <button data-action="next-group" ${state.groupIndex === groups.length - 1 ? 'disabled' : ''}>Next →</button>
    </div>

    <label for="session-notes">Workout notes</label>
    <textarea id="session-notes" data-field="session-notes" placeholder="How did it feel?">${esc(session.notes)}</textarea>`;
}

/* ---------- Exercise pictures ---------- */
// Two pictures (start and end of the movement), one above the other, filling the screen.
// "Close" goes back to the screen we came from (the picker or the workout).
function viewerScreen() {
  const ex = getExercise(state.viewerExerciseId);
  const pictures = imagesFor(ex).map((file, i) =>
    `<img src="images/${encodeURI(file)}" alt="${esc(ex.name)}, picture ${i + 1}">`).join('');
  return `
    <div class="viewer">
      <h2>${esc(ex.name)}</h2>
      ${pictures || '<p class="muted">No pictures for this exercise yet.</p>'}
      <button class="primary block" data-action="close-viewer">Close</button>
    </div>`;
}

/* ---------- Progress (line graph) ---------- */
// The graph: left-to-right = each time you did this exercise on this day (1, 2, 3...).
// Height = the weight of the FIRST set that time.
// Line colour = reps of the first set: light blue (few) to dark purple (many).
const COLOR_FEW_REPS = [125, 211, 252];  // light blue (red, green, blue)
const COLOR_MANY_REPS = [91, 33, 182];   // dark purple

// t = 0 gives light blue, t = 1 gives dark purple, in between is a mix.
function repsColor(t) {
  const mix = COLOR_FEW_REPS.map((few, i) => Math.round(few + (COLOR_MANY_REPS[i] - few) * t));
  return `rgb(${mix.join(',')})`;
}

// Every exercise planned on a day (no repeats), in the day's order.
function exercisesOnDay(day) {
  return [...new Set(day.groups.flatMap((g) => g.exerciseIds))].filter(getExercise);
}

// Make sure the picked day + exercise still exist (things can be deleted).
function fixProgressPicks() {
  const day = getDay(state.progressDayId) || data.schedule.days[0];
  state.progressDayId = day ? day.id : null;
  const ids = day ? exercisesOnDay(day) : [];
  if (!ids.includes(state.progressExerciseId)) state.progressExerciseId = ids[0] || null;
}

// One point per workout of that day that included this exercise:
// its first set (lowest set number), oldest workout first.
function progressPoints(dayId, exerciseId) {
  const firstSets = new Map(); // sessionId -> first set of that workout
  for (const s of data.sets) {
    if (s.exerciseId !== exerciseId) continue;
    const session = getSession(s.sessionId);
    if (!session || session.dayId !== dayId) continue;
    const best = firstSets.get(s.sessionId);
    if (!best || s.setNumber < best.setNumber) firstSets.set(s.sessionId, s);
  }
  return [...firstSets.values()].sort((a, b) => a.timestamp - b.timestamp);
}

// Pick a "nice" step size (1, 2, 2.5, 5, 10, 20...) so the weight labels look tidy.
function niceStep(rough) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
  return [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough);
}

// Draw the graph as an SVG picture. `sets` = the first set of each workout, oldest first.
function chartHtml(sets) {
  // If lbs and kg were mixed, show everything in the unit used most recently.
  const unit = sets[sets.length - 1].unit;
  const weights = sets.map((s) => (s.unit === unit ? s.weight : unit === 'kg' ? s.weight / 2.20462 : s.weight * 2.20462));
  const reps = sets.map((s) => s.reps);
  const n = sets.length;

  // Size of the picture and the empty space around the plot area.
  const W = 360, H = 240, left = 48, right = 16, top = 16, bottom = 44;
  const plotW = W - left - right, plotH = H - top - bottom;

  // Weight axis (up): pick a tidy range with a little room above and below.
  const lo = Math.min(...weights), hi = Math.max(...weights);
  const step = niceStep(Math.max((hi - lo) / 4, 1));
  let yMin = Math.floor(lo / step) * step, yMax = Math.ceil(hi / step) * step;
  if (yMin === lo) yMin -= step;
  if (yMax === hi) yMax += step;
  yMin = Math.max(0, yMin);

  // Turn a workout number / a weight into a position on the picture.
  const inset = 12; // keeps the first and last dots off the axis line
  const px = (i) => (n === 1 ? left + plotW / 2 : left + inset + ((plotW - 2 * inset) * i) / (n - 1));
  const py = (w) => top + plotH * (1 - (w - yMin) / (yMax - yMin));

  // Colour of each point: fewest reps in the data = light blue, most = dark purple.
  const rMin = Math.min(...reps), rMax = Math.max(...reps);
  const colors = reps.map((r) => repsColor(rMax === rMin ? 0.5 : (r - rMin) / (rMax - rMin)));

  // Horizontal grid lines + weight labels on the left.
  let grid = '';
  for (let v = yMin; v <= yMax + step / 100; v += step) {
    const y = py(v).toFixed(1);
    grid += `<line class="grid" x1="${left}" x2="${W - right}" y1="${y}" y2="${y}"/>` +
      `<text class="tick" x="${left - 6}" y="${Number(y) + 4}" text-anchor="end">${Math.round(v * 100) / 100}</text>`;
  }

  // Workout numbers along the bottom (skip some if there are many).
  const every = Math.ceil(n / 8);
  let xTicks = '';
  for (let i = 0; i < n; i += every) {
    xTicks += `<text class="tick" x="${px(i).toFixed(1)}" y="${top + plotH + 16}" text-anchor="middle">${i + 1}</text>`;
  }

  // The line (needs 2+ points) uses a gradient that passes through each point's colour.
  let line = '';
  if (n > 1) {
    const stops = colors.map((c, i) => `<stop offset="${(i / (n - 1) * 100).toFixed(1)}%" stop-color="${c}"/>`).join('');
    const path = weights.map((w, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(w).toFixed(1)}`).join(' ');
    line = `<defs><linearGradient id="reps-line" gradientUnits="userSpaceOnUse" x1="${px(0).toFixed(1)}" y1="0" x2="${px(n - 1).toFixed(1)}" y2="0">${stops}</linearGradient></defs>` +
      `<path d="${path}" fill="none" stroke="url(#reps-line)" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  // One dot per workout. The two data-line texts are what the hover / touch tooltip shows (see showChartTip).
  const dots = weights.map((w, i) =>
    `<circle class="pt" cx="${px(i).toFixed(1)}" cy="${py(w).toFixed(1)}" r="6" fill="${colors[i]}" ` +
    `data-line1="${Math.round(w * 10) / 10} ${unit} × ${reps[i]} reps" ` +
    `data-line2="Workout ${i + 1} · ${getSession(sets[i].sessionId).date}"></circle>`).join('');

  return `
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Weight of the first set over time">
      ${grid}${xTicks}
      <text class="axis-label" x="${left + plotW / 2}" y="${H - 6}" text-anchor="middle">Times you did this (workout #)</text>
      <text class="axis-label" transform="translate(12 ${top + plotH / 2}) rotate(-90)" text-anchor="middle">Weight (${unit})</text>
      ${line}${dots}
      <g class="tip"></g>
    </svg>
    <div class="legend">
      <span>${rMin} reps</span>
      <span class="bar" style="background:linear-gradient(90deg, ${repsColor(0)}, ${repsColor(1)})"></span>
      <span>${rMin === rMax ? '' : rMax + ' reps'}</span>
    </div>
    <p class="muted">Touch or hover over the graph to see the weight and reps of each point.</p>
    <p class="muted">Line color = reps in the first set (light blue = fewer, dark purple = more).</p>`;
}

// Find the graph point closest (left to right) to the finger / mouse and show its details in a small box.
function chartPointer(event) {
  const svg = event.target.closest && event.target.closest('svg.chart');
  if (!svg) return;
  const box = svg.getBoundingClientRect();
  const x = ((event.clientX - box.left) / box.width) * svg.viewBox.baseVal.width; // pixels -> picture units
  let nearest = null;
  for (const dot of svg.querySelectorAll('.pt')) {
    if (!nearest || Math.abs(dot.getAttribute('cx') - x) < Math.abs(nearest.getAttribute('cx') - x)) nearest = dot;
  }
  if (nearest) showChartTip(svg, nearest);
}

function showChartTip(svg, dot) {
  const lines = [dot.dataset.line1, dot.dataset.line2];
  const cx = Number(dot.getAttribute('cx')), cy = Number(dot.getAttribute('cy'));
  const width = Math.max(...lines.map((l) => l.length)) * 6.6 + 16, height = 40;
  const pageWidth = svg.viewBox.baseVal.width;
  const x = Math.min(Math.max(cx - width / 2, 4), pageWidth - width - 4); // keep the box inside the picture
  const y = cy - height - 12 >= 2 ? cy - height - 12 : cy + 14;            // above the dot, or below if no room
  svg.querySelector('.tip').innerHTML =
    `<rect class="tip-box" x="${x}" y="${y}" width="${width}" height="${height}" rx="8"/>` +
    `<text class="tip-text strong" x="${x + 8}" y="${y + 16}">${esc(lines[0])}</text>` +
    `<text class="tip-text" x="${x + 8}" y="${y + 32}">${esc(lines[1])}</text>`;
  svg.querySelectorAll('.pt').forEach((p) => p.classList.toggle('active', p === dot));
}

function hideChartTip(svg) {
  svg.querySelector('.tip').innerHTML = '';
  svg.querySelectorAll('.pt.active').forEach((p) => p.classList.remove('active'));
}

function progressScreen() {
  const day = getDay(state.progressDayId);
  const topbar = `
    <div class="topbar">
      <button data-action="go-home">‹ Home</button>
      <span class="title">Progress</span>
      <span style="width:80px"></span>
    </div>`;
  if (!day) return topbar + '<div class="card"><p>Add a workout day first. Your progress shows up here once you have logged sets.</p></div>';

  const exIds = exercisesOnDay(day);
  const ex = getExercise(state.progressExerciseId);
  const points = ex ? progressPoints(day.id, ex.id) : [];

  let chart;
  if (!ex) chart = `<p>${esc(day.name)} has no exercises yet. Add some in the day editor.</p>`;
  else if (points.length === 0) chart = `<p>Nothing logged yet for ${esc(ex.name)} on ${esc(day.name)}. Do a workout and the graph will appear.</p>`;
  else chart = chartHtml(points);

  const exChips = exIds.map((id) => `
    <button class="chip ${id === state.progressExerciseId ? 'selected' : ''}" data-action="progress-exercise" data-id="${id}">${esc(getExercise(id).name)}</button>`).join('');
  const dayChips = data.schedule.days.map((d) => `
    <button class="chip ${d.id === day.id ? 'selected' : ''}" data-action="progress-day" data-id="${d.id}">
      <span class="chip-dot" style="background:${d.color}"></span>${esc(d.name)}</button>`).join('');

  return `
    ${topbar}
    <div class="card">
      <h2>${ex ? esc(ex.name) : 'Progress'}</h2>
      <p class="muted">${esc(day.name)}${points.length ? ` · ${points.length} time${points.length === 1 ? '' : 's'}` : ''}</p>
      ${chart}
    </div>
    <h3>Exercise</h3>
    <div class="chips">${exChips || '<p class="muted">No exercises on this day.</p>'}</div>
    <h3>Day</h3>
    <div class="chips">${dayChips}</div>`;
}

/* ---------- Backup ---------- */
function backupScreen() {
  return `
    <div class="topbar">
      <button data-action="go-home">‹ Home</button>
      <span class="title">Backup &amp; restore</span>
      <span style="width:80px"></span>
    </div>
    <div class="card">
      <p>Your data lives only on this device. Export a backup file now and then, and keep it somewhere safe (Files, email, cloud drive).</p>
      <button class="primary block" data-action="export">Export backup</button>
    </div>
    <div class="card">
      <p>Make a spreadsheet of your most recent weights, reps and sets for every exercise, with each day in its own color. It downloads as an .xlsx file: open it in Google Sheets (upload it to Google Drive, or File &rarr; Import in Sheets) or in Excel. This is a report only; to restore your data use the backup file above.</p>
      <button class="primary block" data-action="export-sheet">Export to spreadsheet</button>
    </div>
    <div class="card">
      <p>Restore from a backup file. <strong>This replaces everything currently in the app.</strong></p>
      <input type="file" id="import-file" accept=".json,application/json" hidden>
      <button class="block" data-action="import">Import backup</button>
    </div>`;
}

/* ============================================================
   5. CLICK / INPUT HANDLING
   One listener on the whole app; it looks at data-action on the
   button that was tapped ("event delegation").
   ============================================================ */

$app.addEventListener('click', async (event) => {
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const day = getDay(state.dayId);

  switch (action) {
    /* --- Home --- */
    case 'go-home':
      // Leaving the day editor: everything is already saved as you edit; just make sure the name isn't empty.
      if (state.screen === 'day' && day) {
        if (!day.name.trim()) day.name = 'New Day';
        await saveSchedule();
      }
      return go('home');
    case 'open-backup': return go('backup');
    case 'open-progress': return go('progress');

    /* --- Progress --- */
    // Picking a day keeps the same exercise if that day has it (render picks another if not).
    case 'progress-day': state.progressDayId = el.dataset.id; saveState(); return render();
    case 'progress-exercise': state.progressExerciseId = el.dataset.id; saveState(); return render();
    case 'resume': {
      // Resume = put me back EXACTLY where I was. The saved state already has the
      // exercise, set number and any numbers I had typed, so we don't recompute them.
      const s = unfinishedSession();
      if (state.sessionId === s.id && state.dayId === s.dayId) {
        state.screen = 'workout';
        saveState(); render(); window.scrollTo(0, 0);
        return;
      }
      // Saved position belongs to something else: restart at this workout's first exercise.
      state.sessionId = s.id; state.dayId = s.dayId; state.screen = 'workout';
      return gotoGroup(0);
    }
    case 'add-day': {
      const newDay = {
        id: uid(), name: 'New Day', color: DAY_COLORS[data.schedule.days.length % DAY_COLORS.length],
        photo: null, weekday: '', groups: [],
      };
      data.schedule.days.push(newDay);
      await saveSchedule();
      return go('day', { dayId: newDay.id });
    }
    case 'edit-day': return go('day', { dayId: el.dataset.id });
    case 'start-workout': return startWorkout(el.dataset.id);

    /* --- Day editor --- */
    case 'set-color': day.color = el.dataset.color; await saveSchedule(); return render();
    case 'toggle-color-panel': colorPanelOpen = !colorPanelOpen; return render();
    case 'sets-plus': day.groups[el.dataset.index].plannedSets = Math.min(20, day.groups[el.dataset.index].plannedSets + 1); await saveSchedule(); return render();
    case 'sets-minus': day.groups[el.dataset.index].plannedSets = Math.max(1, day.groups[el.dataset.index].plannedSets - 1); await saveSchedule(); return render();
    case 'move-up': case 'move-down': {
      const i = Number(el.dataset.index);
      const j = action === 'move-up' ? i - 1 : i + 1;
      [day.groups[i], day.groups[j]] = [day.groups[j], day.groups[i]];
      await saveSchedule();
      return render();
    }
    case 'remove-group': day.groups.splice(Number(el.dataset.index), 1); await saveSchedule(); return render();
    case 'save-day':
      if (!day.name.trim()) day.name = 'New Day';
      try { await saveSchedule(); } catch (err) { return toast('Could not save: ' + err.message); }
      toast('Day saved');
      return go('home');
    case 'delete-day':
      if (!confirm(`Delete "${day.name}"?`)) return;
      // Close any unfinished workout for this day (its logged sets stay saved),
      // otherwise it would be stuck "in progress" with no day to show.
      for (const s of data.sessions.filter((s) => s.dayId === day.id && !s.finished)) {
        s.finished = true;
        await dbPut('sessions', s);
      }
      data.schedule.days = data.schedule.days.filter((d) => d.id !== day.id);
      await saveSchedule();
      return go('home');

    /* --- Exercise pictures (opened from the picker or the workout) --- */
    case 'view-exercise':
      viewerScroll = window.scrollY; // remember where we were on the page
      return go('viewer', { viewerExerciseId: el.dataset.id, viewerReturn: state.screen });
    case 'close-viewer':
      // Go back to the same screen, scrolled to the same spot (go() would jump to the top).
      state.screen = state.viewerReturn;
      saveState(); render(); window.scrollTo(0, viewerScroll);
      return;

    /* --- Picker --- */
    case 'open-picker': pickerSearch = ''; pickerFilters.clear(); pickerCreating = false; return go('picker');
    case 'picker-filter': {
      const section = el.dataset.section;
      if (pickerFilters.has(section)) pickerFilters.delete(section); else pickerFilters.add(section);
      return render();
    }
    case 'close-picker': return go('day');
    case 'new-custom': pickerCreating = true; return render();
    case 'picker-back-list': pickerCreating = false; return render();
    case 'pick-exercise': return addExerciseToDay(el.dataset.id);
    case 'save-custom': {
      const name = document.getElementById('new-name').value.trim();
      if (!name) return toast('Please type a name');
      const ex = makeExercise(name, document.getElementById('new-muscles').value, '', true);
      ex.notes = document.getElementById('new-notes').value.trim();
      ex.defaultUnit = document.getElementById('new-unit').value;
      data.exercises.push(ex);
      await dbPut('exercises', ex);
      return addExerciseToDay(ex.id);
    }

    /* --- Workout --- */
    case 'bump': {
      const input = document.getElementById(el.dataset.field);
      const next = Math.max(0, (parseFloat(input.value) || 0) + Number(el.dataset.delta));
      input.value = String(Math.round(next * 100) / 100);
      state.draft[el.dataset.field] = input.value;
      return saveState();
    }
    case 'set-unit': state.draft.unit = el.dataset.unit; saveState(); return render();
    case 'set-done': return logSet();
    case 'undo': return undoLastSet();
    case 'prev-group': return gotoGroup(state.groupIndex - 1);
    case 'next-group': return gotoGroup(state.groupIndex + 1);
    case 'finish': return finishWorkout();

    /* --- Backup --- */
    case 'export': return exportBackup();
    case 'export-sheet': return exportSpreadsheet();
    case 'import': return document.getElementById('import-file').click();
  }
});

// Typing in inputs: save without redrawing (redrawing would close the keyboard).
$app.addEventListener('input', async (event) => {
  const field = event.target.dataset.field;
  if (!field) return;
  const day = getDay(state.dayId);
  switch (field) {
    case 'reps': case 'weight': state.draft[field] = event.target.value; return saveState();
    case 'day-name': day.name = event.target.value; return saveSchedule();
    case 'session-notes': {
      const s = getSession(state.sessionId);
      s.notes = event.target.value;
      return dbPut('sessions', s);
    }
    case 'picker-search':
      pickerSearch = event.target.value;
      return (document.getElementById('picker-list').innerHTML = pickerListHtml());

    /* --- Custom color picker (day editor) --- */
    case 'color-v': // brightness slider
      colorHsv.v = Number(event.target.value) / 100;
      return setDayColor(rgbToHex(...hsvToRgb(colorHsv.h, colorHsv.s, colorHsv.v)));
    case 'rgb-r': case 'rgb-g': case 'rgb-b': {
      const part = (id) => Math.max(0, Math.min(255, Math.round(Number(document.getElementById(id).value) || 0)));
      const rgb = [part('rgb-r'), part('rgb-g'), part('rgb-b')];
      colorHsv = rgbToHsv(...rgb);
      return setDayColor(rgbToHex(...rgb), true); // true = don't rewrite the box being typed in
    }
  }
});

/* ---- Pointer (finger / mouse) handling: the graph tooltip and the color wheel ---- */

let draggingWheel = false;
$app.addEventListener('pointerdown', (event) => {
  chartPointer(event); // tapping the graph shows that point's details
  const wheel = event.target.closest('.wheel-wrap');
  if (wheel) {
    draggingWheel = true;
    wheel.setPointerCapture(event.pointerId); // keep getting moves even if the finger slides off the wheel
    pickFromWheel(event);
  }
});
$app.addEventListener('pointermove', (event) => {
  if (draggingWheel) pickFromWheel(event);
  else chartPointer(event); // mouse hover, or finger sliding along the graph
});
$app.addEventListener('pointerup', () => { draggingWheel = false; });
$app.addEventListener('pointercancel', () => { draggingWheel = false; });
// Mouse leaving the graph hides the box. (A finger lifting leaves it showing so you can read it.)
$app.addEventListener('pointerleave', (event) => {
  if (event.pointerType === 'mouse' && event.target.matches && event.target.matches('svg.chart')) hideChartTip(event.target);
}, true);

/* ---- Custom color picker ---- */

// Paint the wheel (the hue goes around the circle, white in the middle), then place the marker.
function setupColorPanel() {
  const day = getDay(state.dayId);
  colorHsv = rgbToHsv(...hexToRgb(day.color));
  const canvas = document.querySelector('.wheel');
  const size = canvas.width, radius = size / 2;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - radius, dy = y + 0.5 - radius;
      const distance = Math.hypot(dx, dy) / radius;
      if (distance > 1) continue; // outside the circle stays see-through
      const hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      const [r, g, b] = hsvToRgb(hue, distance, 1);
      const i = (y * size + x) * 4;
      image.data[i] = r; image.data[i + 1] = g; image.data[i + 2] = b; image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  updateColorPanel();
}

// Finger / mouse on the wheel: angle = hue, distance from the middle = saturation.
function pickFromWheel(event) {
  const box = document.querySelector('.wheel-wrap').getBoundingClientRect();
  const dx = event.clientX - (box.left + box.width / 2);
  const dy = event.clientY - (box.top + box.height / 2);
  colorHsv.h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
  colorHsv.s = Math.min(1, Math.hypot(dx, dy) / (box.width / 2));
  setDayColor(rgbToHex(...hsvToRgb(colorHsv.h, colorHsv.s, colorHsv.v)));
}

let colorSaveTimer;
function setDayColor(hex, keepRgbBoxes = false) {
  getDay(state.dayId).color = hex;
  updateColorPanel(keepRgbBoxes);
  clearTimeout(colorSaveTimer);
  colorSaveTimer = setTimeout(saveSchedule, 200); // save once the dragging pauses, not on every pixel
}

// Update the pieces of the picker in place (no redraw: a redraw would interrupt the drag).
function updateColorPanel(keepRgbBoxes = false) {
  const color = getDay(state.dayId).color;
  const { h, s, v } = colorHsv;
  const marker = document.querySelector('.wheel-marker');
  marker.style.left = 50 + Math.cos(h * Math.PI / 180) * s * 50 + '%';
  marker.style.top = 50 + Math.sin(h * Math.PI / 180) * s * 50 + '%';
  document.querySelector('.wheel-dark').style.opacity = 1 - v; // a black layer over the wheel = brightness
  document.getElementById('color-v').value = Math.round(v * 100);
  document.querySelector('.color-preview').style.background = color;
  if (!keepRgbBoxes) {
    ['rgb-r', 'rgb-g', 'rgb-b'].forEach((id, i) => { document.getElementById(id).value = hexToRgb(color)[i]; });
  }
  document.querySelectorAll('.swatch[data-color]').forEach((b) => b.classList.toggle('selected', b.dataset.color === color));
}

$app.addEventListener('change', (event) => {
  if (event.target.dataset.field === 'day-weekday') {
    getDay(state.dayId).weekday = event.target.value;
    saveSchedule();
  }
  if (event.target.id === 'import-file') importBackup(event.target.files[0]);
});

/* ---- Actions used above ---- */

async function addExerciseToDay(exerciseId) {
  const day = getDay(state.dayId);
  // Stored as a "group" with one exercise, so supersets (Phase 2) need no data change.
  day.groups.push({ id: uid(), exerciseIds: [exerciseId], plannedSets: 3 });
  await saveSchedule();
  pickerCreating = false;
  toast('Added');
  go('day');
}

async function startWorkout(dayId) {
  const day = getDay(dayId);
  if (day.groups.length === 0) return toast('Add an exercise to this day first');

  // Start ALWAYS begins a brand-new workout. (Use the "Resume" banner to continue.)
  // An unfinished one gets closed first; the sets already logged stay saved.
  const open = unfinishedSession();
  if (open) {
    const sameDay = open.dayId === dayId;
    const msg = sameDay
      ? 'This workout is already in progress. Start over from scratch? (Sets you already logged stay saved.) Tap Cancel, then use "Resume" to continue instead.'
      : 'You have another workout in progress. Finish it and start this one?';
    if (!confirm(msg)) return;
    open.finished = true;
    await dbPut('sessions', open);
  }
  const session = {
    id: uid(), date: new Date().toISOString().slice(0, 10), scheduleId: data.schedule.id,
    dayId, notes: '', finished: false,
  };
  data.sessions.push(session);
  await dbPut('sessions', session);
  state.sessionId = session.id; state.dayId = dayId;
  state.screen = 'workout';
  gotoGroup(0);
}

let isLogging = false; // stops a fast double-tap from saving the same set twice

async function logSet() {
  if (isLogging) return;
  isLogging = true;
  try {
    await logSetInner();
  } finally {
    isLogging = false;
  }
}

async function logSetInner() {
  const day = getDay(state.dayId);
  const group = day.groups[state.groupIndex];
  const exId = group.exerciseIds[0];
  // Read what's actually in the boxes right now (not just our saved copy).
  state.draft.reps = document.getElementById('reps').value;
  state.draft.weight = document.getElementById('weight').value;
  const reps = parseInt(state.draft.reps, 10);
  const weight = parseFloat(state.draft.weight);
  if (!(reps > 0)) return toast('Enter the number of reps');
  if (!(weight >= 0)) return toast('Enter a weight (0 for bodyweight)');

  const set = {
    id: uid(), sessionId: state.sessionId, exerciseId: exId, setNumber: state.setNumber,
    reps, weight, unit: state.draft.unit, tags: [], timestamp: Date.now(),
  };
  // Re-logging a set number that already exists (going back to a finished exercise) replaces it.
  const old = data.sets.find((x) => x.sessionId === state.sessionId && x.exerciseId === exId && x.setNumber === state.setNumber);
  if (old) { data.sets = data.sets.filter((x) => x.id !== old.id); await dbDelete('sets', old.id); }
  // Save to the database FIRST. Only if that worked do we count it as logged.
  try {
    await dbPut('sets', set);
  } catch (err) {
    console.error(err);
    return toast('Could not save this set. Try again.');
  }
  data.sets.push(set);

  // Next: another set of this exercise, or on to the next exercise once planned sets are done.
  const doneCount = setsFor(state.sessionId, exId).length;
  if (doneCount >= group.plannedSets) {
    if (state.groupIndex < day.groups.length - 1) {
      toast('Exercise done, next up!');
      return gotoGroup(state.groupIndex + 1);
    }
    // Last exercise, all planned sets done: finish the workout (no "extra set").
    return finishWorkout(true);
  }
  state.setNumber = doneCount + 1;
  loadDraft(); // boxes show last time's numbers for the next set
  saveState();
  render();
}

async function undoLastSet() {
  const mine = data.sets.filter((s) => s.sessionId === state.sessionId).sort((a, b) => b.timestamp - a.timestamp);
  const last = mine[0];
  if (!last) return;
  data.sets = data.sets.filter((s) => s.id !== last.id);
  await dbDelete('sets', last.id);
  // Go back to that exercise and set, with its numbers back in the boxes.
  const day = getDay(state.dayId);
  state.groupIndex = Math.max(0, day.groups.findIndex((g) => g.exerciseIds[0] === last.exerciseId));
  state.setNumber = last.setNumber;
  loadDraft(); // same rule everywhere: last time's numbers for this set
  saveState();
  render();
  toast('Last set removed');
}

async function finishWorkout(auto = false) {
  const count = data.sets.filter((s) => s.sessionId === state.sessionId).length;
  if (!auto && !confirm(`Finish this workout? (${count} set${count === 1 ? '' : 's'} logged)`)) return;
  const session = getSession(state.sessionId);
  session.finished = true;
  await dbPut('sessions', session);
  state.sessionId = null;
  go('home');
  toast(`Saved! ${count} set${count === 1 ? '' : 's'} logged`);
}

/* ============================================================
   6. BACKUP (export / import)
   Export = one .json file with everything. Import = read it back.
   ============================================================ */

async function exportBackup() {
  const backup = {
    app: 'teo-workout-planner',
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {
      exercises: await dbGetAll('exercises'),
      schedules: await dbGetAll('schedules'),
      sessions: await dbGetAll('sessions'),
      sets: await dbGetAll('sets'),
    },
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `workout-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast('Backup file created');
}

async function importBackup(file) {
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    const d = backup.data;
    // Basic check that this really is one of our backup files.
    if (backup.app !== 'teo-workout-planner' || !d ||
        !['exercises', 'schedules', 'sessions', 'sets'].every((k) => Array.isArray(d[k]))) {
      throw new Error('Not a workout backup file');
    }
    if (!confirm('Replace ALL current data with this backup?')) return;

    // Every record needs an id, otherwise the database refuses it.
    for (const store of ['exercises', 'schedules', 'sessions', 'sets']) {
      if (!d[store].every((item) => item && item.id)) throw new Error('Backup file is damaged');
    }
    // Replace everything in ONE transaction: it all succeeds, or nothing changes.
    // (So a bad file can never leave you with half-wiped data.)
    const tx = db.transaction(['exercises', 'schedules', 'sessions', 'sets', 'appState'], 'readwrite');
    for (const store of ['exercises', 'schedules', 'sessions', 'sets']) {
      const os = tx.objectStore(store);
      os.clear();
      d[store].forEach((item) => os.put(item));
    }
    tx.objectStore('appState').clear();
    await txDone(tx);
    state = { ...state, screen: 'home', dayId: null, sessionId: null, groupIndex: 0, setNumber: 1 };
    await loadData();
    await saveState();
    go('home');
    toast('Backup restored');
  } catch (err) {
    console.error(err);
    alert('Could not import that file: ' + err.message);
  }
}

/* ============================================================
   7. SPREADSHEET EXPORT (.xlsx, opens in Google Sheets)
   There is no server, so the app can't write into a Google account by itself.
   Instead it builds a real Excel file (.xlsx) on the phone. Google Sheets opens
   .xlsx files with all colors and layout kept. An .xlsx file is a zip of a few
   small XML files, so we write the zip by hand (no libraries needed).
   ============================================================ */

// ---- Zip writer (files stored without compression; they are tiny) ----
const CRC_TABLE = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table.push(c >>> 0);
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files = [{ name: 'xl/workbook.xml', text: '<xml...>' }, ...]  ->  Uint8Array of a .zip file
function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const file of files) {
    const name = enc.encode(file.name);
    const body = enc.encode(file.text);
    const crc = crc32(body);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);  // "local file" marker
    header.setUint16(4, 20, true);          // version needed
    header.setUint16(6, 0x0800, true);      // names are UTF-8
    header.setUint16(8, 0, true);           // 0 = stored, not compressed
    header.setUint16(10, dosTime, true);
    header.setUint16(12, dosDate, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, body.length, true);
    header.setUint32(22, body.length, true);
    header.setUint16(26, name.length, true);
    parts.push(new Uint8Array(header.buffer), name, body);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);   // "directory entry" marker
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(12, dosTime, true);
    entry.setUint16(14, dosDate, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, body.length, true);
    entry.setUint32(24, body.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);      // where this file starts
    central.push(new Uint8Array(entry.buffer), name);
    offset += 30 + name.length + body.length;
  }

  const centralSize = central.reduce((sum, p) => sum + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);       // "end of zip" marker
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

// ---- Colors ----
// Mix a color with white (amount 0 = original, 1 = white) or black (amount 0 = original, 1 = black).
const mixColor = (hex, target, amount) =>
  hexToRgb(hex).map((v) => Math.round(v + (target - v) * amount));
const argb = (rgb) => 'FF' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
const lighter = (hex, amount) => argb(mixColor(hex, 255, amount)); // "more see-through" version of a color
const darker = (hex, amount) => argb(mixColor(hex, 0, amount));

// ---- Cell styles ----
// Every look (fill color, font, border...) gets a number; cells just point to that number.
function makeStyleBook() {
  const fonts = ['<font><sz val="11"/><name val="Arial"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const seen = new Map(); // look description -> style number
  const indexOf = (list, xml) => { let i = list.indexOf(xml); if (i < 0) i = list.push(xml) - 1; return i; };

  // look = { bg, color, bold, italic, size, align, wrap, top }   (colors are ARGB like 'FF1F2A44')
  function style(look) {
    const key = JSON.stringify(look);
    if (seen.has(key)) return seen.get(key);
    const font = indexOf(fonts, `<font>${look.bold ? '<b/>' : ''}${look.italic ? '<i/>' : ''}<sz val="${look.size || 11}"/>` +
      `<color rgb="${look.color || 'FF000000'}"/><name val="Arial"/></font>`);
    const fill = look.bg ? indexOf(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${look.bg}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const edge = (side, color, weight) => `<${side} style="${weight}"><color rgb="${color}"/></${side}>`;
    const border = indexOf(borders, `<border><left/><right/>${look.top ? edge('top', look.top, 'medium') : '<top/>'}` +
      `${look.bottom ? edge('bottom', look.bottom, 'thin') : '<bottom/>'}<diagonal/></border>`);
    const xf = `<xf numFmtId="0" fontId="${font}" fillId="${fill}" borderId="${border}" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">` +
      `<alignment horizontal="${look.align || 'left'}" vertical="center"${look.wrap ? ' wrapText="1"' : ''}/></xf>`;
    const number = xfs.push(xf) - 1;
    seen.set(key, number);
    return number;
  }

  const xml = () => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<fonts count="${fonts.length}">${fonts.join('')}</fonts>` +
    `<fills count="${fills.length}">${fills.join('')}</fills>` +
    `<borders count="${borders.length}">${borders.join('')}</borders>` +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  return { style, xml };
}

// 1 -> A, 2 -> B, 27 -> AA
function columnLetter(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// For every exercise on every day: the numbers from the MOST RECENT workout of that day that
// included it, one entry per set. If it was never logged, it has no sets (cells stay empty).
function trackerData() {
  const days = data.schedule.days.filter((d) => d.groups.length > 0).map((day, i) => {
    const exercises = day.groups.flatMap((g) => g.exerciseIds.map((id) => ({ id, planned: g.plannedSets })))
      .filter((e) => getExercise(e.id))
      .map((e) => {
        const mine = data.sets.filter((s) => {
          const session = getSession(s.sessionId);
          return s.exerciseId === e.id && session && session.dayId === day.id;
        });
        const latest = mine.sort((a, b) => b.timestamp - a.timestamp)[0];
        const sets = []; // sets[0] = set 1, and so on
        if (latest) {
          for (const s of mine.filter((x) => x.sessionId === latest.sessionId).sort((a, b) => a.timestamp - b.timestamp)) {
            sets[s.setNumber - 1] = s; // if a set number was logged twice, the newer one wins
          }
        }
        return { name: getExercise(e.id).name, planned: e.planned, sets };
      });
    return { number: i + 1, day, exercises };
  });
  return days;
}

function buildTrackerXlsx() {
  const days = trackerData();
  const book = makeStyleBook();
  const allExercises = days.flatMap((d) => d.exercises);
  // How many "SET n" column pairs: the most sets any exercise has (planned count if it was never logged).
  const setCount = Math.max(1, ...allExercises.map((e) => e.sets.length || e.planned));
  const lastCol = 3 + setCount * 2;
  // Weight header and cells: if everything is in one unit, plain numbers under "lbs" or "kg".
  // If lbs and kg are mixed, write each weight as text with its unit ("50 kg") so nothing is misread.
  const units = new Set(allExercises.flatMap((e) => e.sets.filter(Boolean).map((s) => s.unit)));
  const mixedUnits = units.size > 1;
  const weightHeader = mixedUnits ? 'weight' : (units.values().next().value || 'lbs');

  const NAVY = 'FF1F2A44', BLUE = 'FF3F6DB5', LIGHT_BLUE = 'FF5B8BD0', WHITE = 'FFFFFFFF';
  const rows = [];   // rows[r] = { cells: { columnNumber: {v, s} }, height }
  const merges = [];
  const put = (r, c, v, look) => {
    rows[r] = rows[r] || { cells: {} };
    rows[r].cells[c] = { v, s: book.style(look) };
  };
  // Fill a whole range with one look and put text in the first cell (so merged areas look right).
  const fillRange = (r1, c1, r2, c2, v, look) => {
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) put(r, c, r === r1 && c === c1 ? v : '', look);
    if (r1 !== r2 || c1 !== c2) merges.push(`${columnLetter(c1)}${r1}:${columnLetter(c2)}${r2}`);
  };

  // Row 1: title. Row 2: note.
  fillRange(1, 1, 1, lastCol, `${days.length}-DAY WORKOUT TRACKER`, { bg: NAVY, color: WHITE, bold: true, size: 24 });
  rows[1].height = 44;
  const exportedOn = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  fillRange(2, 1, 2, lastCol, `Most recent weight and reps for each exercise, exported ${exportedOn}.`,
    { bg: 'FFF3F3F3', color: 'FF666666', italic: true, size: 10 });
  rows[2].height = 24;

  // Rows 3-4: column headings.
  fillRange(3, 1, 3, 3, 'EXERCISE', { bg: NAVY, color: WHITE, bold: true, align: 'center', size: 12 });
  for (let n = 1; n <= setCount; n++) {
    fillRange(3, 2 + n * 2, 3, 3 + n * 2, `SET ${n}`, { bg: BLUE, color: WHITE, bold: true, align: 'center', size: 12 });
    put(4, 2 + n * 2, weightHeader, { bg: LIGHT_BLUE, color: WHITE, bold: true, align: 'center' });
    put(4, 3 + n * 2, 'reps', { bg: LIGHT_BLUE, color: WHITE, bold: true, align: 'center' });
  }
  ['Day', 'Exercise', 'Target'].forEach((t, i) => put(4, i + 1, t, { bg: NAVY, color: WHITE, bold: true, align: 'center' }));
  rows[3].height = 26;
  rows[4].height = 22;

  // Day blocks. Each day gets its own color: a light tint of the color picked for the day.
  let r = 5;
  for (const { number, day, exercises } of days) {
    const tint = lighter(day.color, 0.82);
    const line = argb(hexToRgb(day.color)); // solid color line above the block
    const first = r;
    exercises.forEach((e, i) => {
      const top = i === 0 ? line : null;
      const base = { bg: tint, top };
      if (i === 0) {
        // The "Day 1: Push" cell spans all of the day's rows.
        fillRange(first, 1, first + exercises.length - 1, 1, `Day ${number}:\n${day.name}`,
          { bg: tint, top: line, color: darker(day.color, 0.4), bold: true, align: 'center', wrap: true, size: 12 });
      } else {
        put(r, 1, '', { bg: tint });
      }
      put(r, 2, e.name, { ...base, bold: true });
      put(r, 3, `${e.planned} sets`, { ...base, align: 'center' });
      for (let n = 1; n <= setCount; n++) {
        const s = e.sets[n - 1];
        const weight = s ? (mixedUnits ? `${s.weight} ${s.unit}` : s.weight) : '';
        put(r, 2 + n * 2, weight, { ...base, align: 'center' });
        put(r, 3 + n * 2, s ? s.reps : '', { ...base, align: 'center' });
      }
      r++;
    });
  }

  // Turn the grid into sheet XML.
  const cellXml = (ref, cell) => {
    const attrs = `r="${ref}" s="${cell.s}"`;
    if (typeof cell.v === 'number') return `<c ${attrs}><v>${cell.v}</v></c>`;
    if (cell.v === '') return `<c ${attrs}/>`;
    return `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
  };
  const sheetRows = rows.map((row, i) => row && (
    `<row r="${i}"${row.height ? ` ht="${row.height}" customHeight="1"` : ''}>` +
    Object.keys(row.cells).map(Number).sort((a, b) => a - b)
      .map((c) => cellXml(columnLetter(c) + i, row.cells[c])).join('') + '</row>')).join('');
  const columns = `<col min="1" max="1" width="14" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/>` +
    `<col min="3" max="3" width="11" customWidth="1"/><col min="4" max="${lastCol}" width="9" customWidth="1"/>`;
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    // Keep the title and column headings in view while scrolling down.
    '<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="4" topLeftCell="A5" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${columns}</cols><sheetData>${sheetRows}</sheetData>` +
    `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells></worksheet>`;

  const xmlHead = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return makeZip([
    { name: '[Content_Types].xml', text: xmlHead + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', text: xmlHead + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', text: xmlHead + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Workout Tracker" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', text: xmlHead + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', text: book.xml() },
    { name: 'xl/worksheets/sheet1.xml', text: sheet },
  ]);
}

function exportSpreadsheet() {
  if (!data.schedule.days.some((d) => d.groups.length > 0)) return toast('Add a day with exercises first');
  const blob = buildTrackerXlsx();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `workout-tracker-${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  toast('Spreadsheet file created');
}

/* ============================================================
   8. STARTUP
   ============================================================ */

async function start() {
  db = await openDb();
  await loadData();
  await loadExerciseImages();

  // Restore "where I was" from last time.
  const saved = await dbGet('appState', 'main');
  if (saved) state = { ...state, ...saved };
  render();

  // Ask the browser not to delete our data when the phone is low on space.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();

  // Register the service worker (makes the app work offline).
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(console.error);
}

start().catch((err) => {
  console.error(err);
  $app.innerHTML = '<p>Sorry, the app could not start: ' + esc(err.message) + '</p>';
});
