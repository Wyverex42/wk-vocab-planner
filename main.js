// ==UserScript==
// @name         Vocab Planner
// @namespace    wyverex
// @version      1.0.0
// @description  Shows unlock information for vocab to allow fast leveling
// @author       Andreas Krügersen
// @match        https://www.wanikani.com/
// @match        https://www.wanikani.com/dashboard
// @grant        none
// ==/UserScript==

(function () {
  if (!window.wkof) {
    alert(
      '"Wanikani Levels Overview Plus" script requires Wanikani Open Framework.\nYou will now be forwarded to installation instructions.'
    );
    window.location.href = "https://community.wanikani.com/t/instructions-installing-wanikani-open-framework/28549";
    return;
  }

  const DayMillis = 24 * 3600 * 1000;
  const WeekMillis = 7 * DayMillis;

  const wkof = window.wkof;
  const shared = {
    settings: {},
    items: {},

    // SRS system id -> [seconds to pass]
    timings: {},
    // SubjectId -> projected pass time millis
    passTimes: {},
    // SubjectId -> projected unlock time millis
    unlockTimes: {},
    // SubjectIds of locked vocab items for the current level
    lockedVocabIds: [],
    // Number of vocab items on stage 0
    availableCount: 0,
    vocabUnlocks: {},
    levelUpTimeMillis: 0,
    numVocabLearnedToday: 0,
    recommendedVocabPerDay: 0,
    // SubjectId -> Normalized lesson order
    lessonOrders: {},

    unlocksElement: null,
    lessonBarElement: null,
  };

  wkof.include("Apiv2,ItemData,Menu,Settings");
  wkof
    .ready("document,Apiv2,ItemData,Menu,Settings")
    .then(load_settings)
    .then(() => wkof.Apiv2.get_endpoint("spaced_repetition_systems").then(calculateSrsTimings))
    .then(startup)
    .catch(loadError);

  function loadError(e) {
    console.error('Failed to load data from WKOF for "Vocab Planner"', e);
  }

  function installCSS() {
    // prettier-ignore
    const content = `
    .vocab-progress-bar {
      background-color: var(--color-level-progress-bar-background);
      color: var(--color-level-progress-bar-text);
      border-radius: 18px;
      height: 18px;
      box-shadow: inset 0px 2px 0 0 var(--color-level-progress-bar-shadow);
      display: flex;
      overflow: hidden;
      margin-top: 15px;
    }

    .vocab-progress-bar__progress {
      background-color: var(--color-vocabulary);
      color: var(--color-level-progress-bar-progress-text);
      border-radius: 18px;
      height: 18px;
      display: flex;
      justify-content: flex-end;
      min-width: 18px;
      transition: width 0.5s ease-in-out;
    }
    `;

    $("head").append("<style>" + content + "</style>");
  }

  function load_settings() {
    let defaults = {
      includeLevelUpDay: true,
      learnAllRadicalsAtOnce: false,
      radicalsPerDay: 5,
      learnAllKanjiAtOnce: false,
      kanjiPerDay: 5,
    };
    return wkof.Settings.load("vocab_planner", defaults).then(() => (shared.settings = wkof.settings.vocab_planner));
  }

  function startup() {
    installCSS();
    installMenu();

    const config = {
      wk_items: {
        options: { subjects: true, assignments: true },
        filters: {
          level: "-1..+0",
          item_type: "rad, kan, voc",
        },
      },
    };
    wkof.ItemData.get_items(config).then(processData);
  }

  // ====================================================================================
  function installMenu() {
    wkof.Menu.insert_script_link({
      name: "vocab_planner",
      submenu: "Settings",
      title: "Vocab Planner",
      on_click: openSettings,
    });
  }

  // prettier-ignore
  function openSettings() {
    let config = {
        script_id: 'vocab_planner',
        title: 'Vocab Planner',
        on_save: settingsSaved,
        on_refresh: settingsRefreshed,
        content: {
            includeLevelUpDay: {type:'checkbox', label:'Learn vocab on level-up day', default:true, hover_tip:"If set, the day you're going to level up is considered a full day to learn vocabulary."},
            learnAllRadicalsAtOnce: {type:"checkbox", label:"Learn all radicals at once", default:true, hover_tip:"If set, assume that all available radicals are learned as a batch as soon as they are unlocked."},
            radicalsPerDay: {type:"number", label:"Radicals/Day", default:5, min:1, hover_tip:"How many radicals do you intend to learn per day?"},
            learnAllKanjiAtOnce: {type:"checkbox", label:"Learn all kanji at once", default:true, hover_tip:"If set, assume that all available kanji are learned as a batch as soon as they are unlocked."},
            kanjiPerDay: {type:"number", label:"Kanji/Day", default:5, min:1, hover_tip:"How many kanji do you intend to learn per day?"},
        }
    };
    let dialog = new wkof.Settings(config);
    dialog.open();
  }

  function settingsSaved() {
    if (shared.unlocksElement) {
      shared.unlocksElement.remove();
      shared.unlocksElement = null;
    }
    if (shared.lessonBarElement) {
      shared.lessonBarElement.remove();
      shared.lessonBarElement = null;
    }
    shared.unlockTimes = {};
    shared.passTimes = {};

    updateData();
  }

  function settingsRefreshed() {}

  // ====================================================================================
  function calculateSrsTimings(data) {
    let result = {};
    const entries = Object.entries(data);
    for (let i = 0; i < entries.length; ++i) {
      const id = entries[i][1].id;
      const system = entries[i][1].data;
      const passingStage = system.passing_stage_position;
      const stages = system.stages;
      let timings = [];
      for (let k = 0; k < passingStage; ++k) {
        timings.push(0);
      }
      timings[passingStage - 1] = getSrsIntervalInSeconds(stages[passingStage - 1]);
      for (k = passingStage - 2; k >= 0; --k) {
        timings[k] = timings[k + 1] + getSrsIntervalInSeconds(stages[k]);
      }
      result[id] = timings;
    }
    shared.timings = result;
  }

  function getSrsIntervalInSeconds(stage) {
    if (stage.interval_unit === "milliseconds") {
      return stage.interval / 1000;
    }
    if (stage.interval_unit === "seconds") {
      return stage.interval;
    }
    if (stage.interval_unit === "minutes") {
      return stage.interval * 60;
    }
    if (stage.interval_unit === "hours") {
      return stage.interval * 3600;
    }
    if (stage.interval_unit === "days") {
      return stage.interval * 3600 * 24;
    }
    if (stage.interval_unit === "weeks") {
      return stage.interval * 3600 * 24 * 7;
    }
    return 0;
  }

  // ====================================================================================
  function processData(items) {
    const byType = wkof.ItemData.get_index(items, "item_type");
    const vocabByStage = wkof.ItemData.get_index(byType.vocabulary, "srs_stage");
    const lockedVocab = vocabByStage[-1];
    shared.lockedVocabIds = lockedVocab.map((item) => item.id);
    shared.availableCount = vocabByStage[0] ? vocabByStage[0].length : 0;

    // SubjectId -> Individual lesson order
    radicalOrders = {};
    getLessonOrders(radicalOrders, wkof.ItemData.get_index(byType.radical, "srs_stage")[0]);
    sortAndNormalizeOrders(shared.lessonOrders, radicalOrders);
    kanjiOrders = {};
    getLessonOrders(kanjiOrders, wkof.ItemData.get_index(byType.kanji, "srs_stage")[-1]);
    getLessonOrders(kanjiOrders, wkof.ItemData.get_index(byType.kanji, "srs_stage")[0]);
    sortAndNormalizeOrders(shared.lessonOrders, kanjiOrders);

    shared.items = items;
    updateData();
  }

  function updateData() {
    const byType = wkof.ItemData.get_index(shared.items, "item_type");
    const subjectsById = wkof.ItemData.get_index(shared.items, "subject_id");
    const vocabByStage = wkof.ItemData.get_index(byType.vocabulary, "srs_stage");
    const lockedVocab = vocabByStage[-1];

    const nowMillis = Date.now();
    const now = new Date(nowMillis);

    const context = {
      lessonOrders: shared.lessonOrders,
      numRadicalsLearnedToday: getNumItemsLearnedToday(byType.radical, now),
      numKanjiLearnedToday: getNumItemsLearnedToday(byType.kanji, now),
    };

    for (let i = 0; i < lockedVocab.length; ++i) {
      projectPassTimeForItem(lockedVocab[i], nowMillis, subjectsById, context);
    }
    shared.vocabUnlocks = groupByTime(shared.lockedVocabIds, shared.unlockTimes);

    const thisLevelKanjiIds = getThisLevelItems(byType.kanji).map((item) => item.id);
    // Kanji for which all the current level vocab has already been unlocked haven't been projected yet.
    // For Kanji with locked vocab this is simply a lookup to a cached value.
    for (i = 0; i < thisLevelKanjiIds.length; ++i) {
      projectPassTimeForItem(subjectsById[thisLevelKanjiIds[i]], nowMillis, subjectsById, context);
    }
    shared.levelUpTimeMillis = projectLevelUpTime(thisLevelKanjiIds);

    shared.numVocabLearnedToday = getNumItemsLearnedToday(byType.vocabulary, now);
    calculateRecommendedVocabPerDay(now);

    addUnlockOverview();
    addVocabLessonBar();
  }

  function getThisLevelItems(items) {
    return items.filter((item) => item.data.level == wkof.user.level);
  }

  function getLessonOrders(outOrders, items) {
    if (items) {
      for (let i = 0; i < items.length; ++i) {
        outOrders[items[i].id] = items[i].data.lesson_position;
      }
    }
  }

  function sortAndNormalizeOrders(outOrders, inOrders) {
    const entries = Object.entries(inOrders);
    entries.sort((lhs, rhs) => lhs[1] - rhs[1]);
    for (let i = 0; i < entries.length; ++i) {
      outOrders[entries[i][0]] = i;
    }
  }

  function getLessonOffset(lessonOrder, perDay, numLearnedToday) {
    if (lessonOrder !== undefined) {
      if (numLearnedToday > perDay) {
        const dayOffset = Math.floor(lessonOrder / perDay);
        return (dayOffset + 1) * DayMillis;
      } else {
        const dayOffset = Math.floor((lessonOrder + numLearnedToday) / perDay);
        return dayOffset * DayMillis;
      }
    }
    return 0;
  }

  function projectPassTimeForItem(item, now, subjectsById, context) {
    if (shared.passTimes[item.id] !== undefined) {
      return shared.passTimes[item.id];
    }

    if (item.assignments) {
      // Item is unlocked or learned
      let availableAt = now;
      if (item.assignments.available_at) {
        // Item was already learned
        availableAt = Date.parse(item.assignments.available_at);
      } else {
        if (item.object == "radical" && !shared.settings.learnAllRadicalsAtOnce && shared.settings.radicalsPerDay > 0) {
          availableAt += getLessonOffset(context.lessonOrders[item.id], shared.settings.radicalsPerDay, context.numRadicalsLearnedToday);
        } else if (item.object == "kanji" && !shared.settings.learnAllKanjiAtOnce && shared.settings.kanjiPerDay > 0) {
          availableAt += getLessonOffset(context.lessonOrders[item.id], shared.settings.kanjiPerDay, context.numKanjiLearnedToday);
        }
      }

      const passTime = getPassTimeMillis(item.data.spaced_repetition_system_id, item.assignments.srs_stage, availableAt, now);
      shared.passTimes[item.id] = passTime;
      return passTime;
    }

    // Item is still locked behind at least one component
    if (shared.unlockTimes[item.id] === undefined) {
      // Get latest pass time of its components to determine the unlock time
      let unlockTimeMillis = 0;
      const components = item.data.component_subject_ids;
      for (let i = 0; i < components.length; ++i) {
        const id = components[i];
        if (shared.passTimes[id] === undefined) {
          const component = subjectsById[id];
          if (component === undefined) {
            // Component not in the level range, it must have passed on an earlier level
            continue;
          }
          projectPassTimeForItem(component, now, subjectsById, context);
        }
        if (shared.passTimes[id] > unlockTimeMillis) {
          unlockTimeMillis = shared.passTimes[id];
        }
      }

      shared.unlockTimes[item.id] = unlockTimeMillis;
    }

    let availableAt = shared.unlockTimes[item.id];
    if (item.object == "kanji" && !shared.settings.learnAllKanjiAtOnce && shared.settings.kanjiPerDay > 0) {
      availableAt += getLessonOffset(context.lessonOrders[item.id], shared.settings.kanjiPerDay, context.numKanjiLearnedToday);
    }

    const passTime = getPassTimeMillis(item.data.spaced_repetition_system_id, 0, availableAt, now);
    shared.passTimes[item.id] = passTime;
    return passTime;
  }

  function getPassTimeMillis(systemId, srsStage, stageTimeMillis, now) {
    const nextReviewTimeMillis = stageTimeMillis ? Math.max(now, stageTimeMillis) : now;
    const timings = shared.timings[systemId];
    const passingStage = timings.length;
    if (srsStage >= passingStage) {
      return 0;
    }
    if (srsStage == passingStage - 1) {
      return nextReviewTimeMillis;
    }
    const secondsToPass = timings[srsStage + 1];
    return nextReviewTimeMillis + secondsToPass * 1000;
  }

  // Given itemIds and a map of Id -> time, returns an array of {timeMilis, count} objects, sorted by timeMillis
  function groupByTime(itemIds, timeSource) {
    const byTime = {};
    for (i = 0; i < itemIds.length; ++i) {
      const timeMillis = timeSource[itemIds[i]];
      if (byTime[timeMillis] === undefined) {
        byTime[timeMillis] = 0;
      }
      byTime[timeMillis]++;
    }
    const byTimeArray = Object.entries(byTime);
    byTimeArray.sort((lhs, rhs) => lhs[0] - rhs[0]);
    return byTimeArray.map((entry) => {
      return { timeMillis: entry[0], count: entry[1] };
    });
  }

  // ====================================================================================
  function projectLevelUpTime(kanjiIds) {
    const kanjiPasses = groupByTime(kanjiIds, shared.passTimes);
    const numKanjisToLevelUp = Math.ceil(kanjiIds.length * 0.9);
    let remaining = kanjiIds.length - numKanjisToLevelUp;
    for (let i = kanjiPasses.length - 1; i >= 0; ++i) {
      remaining -= kanjiPasses[i].count;
      if (remaining <= 0) {
        return parseInt(kanjiPasses[i].timeMillis);
      }
    }
    // Should never happen
    return 0;
  }

  function getNumItemsLearnedToday(items, now) {
    const thisLevel = wkof.user.level;
    let numLearnedToday = 0;
    for (let i = 0; i < items.length; ++i) {
      const item = items[i];
      if (item.data.level == thisLevel && item.assignments && item.assignments.started_at) {
        const startedAt = new Date(Date.parse(item.assignments.started_at));
        if (startedAt.getDate() == now.getDate() && startedAt.getMonth() == now.getMonth()) {
          ++numLearnedToday;
        }
      }
    }
    return numLearnedToday;
  }

  function getNumVocabUntilLevelUp() {
    let numVocab = shared.availableCount;
    for (let i = 0; i < shared.vocabUnlocks.length; ++i) {
      if (shared.vocabUnlocks[i].timeMillis >= shared.levelUpTimeMillis) {
        break;
      }
      numVocab += shared.vocabUnlocks[i].count;
    }
    return numVocab;
  }

  function calculateRecommendedVocabPerDay(now) {
    const numUntilLevelUp = getNumVocabUntilLevelUp() + shared.numVocabLearnedToday;

    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const levelUpDate = new Date(shared.levelUpTimeMillis);
    const levelUpDay = new Date(levelUpDate.getFullYear(), levelUpDate.getMonth(), levelUpDate.getDate());
    const numDays = (levelUpDay.getTime() - today.getTime()) / (24 * 3600 * 1000) + (shared.settings.includeLevelUpDay ? 1 : 0);
    const recommendedVocabPerDay = Math.ceil(numUntilLevelUp / numDays);
    shared.recommendedVocabPerDay = recommendedVocabPerDay;
    return recommendedVocabPerDay;
  }

  // ====================================================================================

  function createDiv(parent, className, style = undefined, innerHTML = undefined) {
    const div = document.createElement("div");
    div.className = className;
    if (style !== undefined) {
      div.style = style;
    }
    if (innerHTML !== undefined) {
      div.innerHTML = innerHTML;
    }
    $(parent).append(div);
    return div;
  }

  function addUnlockOverview() {
    const root = document.getElementsByClassName("wk-panel--review-forecast")[0];
    if (root === undefined) {
      console.log("Review forecast panel not found, can't add Vocab Panel");
      return;
    }
    const contentRoot = root.getElementsByClassName("review-forecast")[0];
    if (contentRoot === undefined) {
      console.log("Review content panel not found, can't add Vocab Panel");
      return;
    }

    const section = createDiv(contentRoot, "review-forecast__day", "margin-top: 10px");
    shared.unlocksElement = section;
    createDiv(section, "review-forecast__day-title", "padding-bottom: 5px", "Vocabulary Unlocks");

    const content = createDiv(section, "review-forecast__day-content");

    const shortFormatter = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
    });
    const longFormatter = new Intl.DateTimeFormat(undefined, {
      day: "2-digit",
      month: "2-digit",
      hour: "numeric",
      minute: "numeric",
    });

    const maxCount = Math.max(shared.availableCount, Math.max(...shared.vocabUnlocks.map((entry) => entry.count)));
    if (shared.availableCount > 0) {
      addUnlockRow(content, "Unlocked", shared.availableCount, shared.availableCount, maxCount);
    }
    let unlockCounter = shared.availableCount;
    let levelUpAdded = false;
    const levelUpDate = new Date(shared.levelUpTimeMillis);
    for (let i = 0; i < shared.vocabUnlocks.length; ++i) {
      const date = new Date(parseInt(shared.vocabUnlocks[i].timeMillis));
      if (!levelUpAdded && levelUpDate <= date) {
        const diff = levelUpDate - Date.now();
        const levelUpTimeStr = (diff > WeekMillis ? longFormatter : shortFormatter).format(levelUpDate);
        addLevelUpRow(content, levelUpTimeStr);
        levelUpAdded = true;
      }

      const diff = date - Date.now();
      const timeStr = (diff > WeekMillis ? longFormatter : shortFormatter).format(date);
      const count = shared.vocabUnlocks[i].count;
      unlockCounter += count;
      addUnlockRow(content, timeStr, count, unlockCounter, maxCount);
    }
  }

  function addLevelUpRow(root, timeStr) {
    const container = createDiv(
      root,
      "review-forecast__day-content",
      "border-bottom: 1px solid var(--color-review-forecast-divider); padding-bottom: var(--spacing-xxtight);"
    );
    const row = createDiv(container, "review-forecast__hour");
    createDiv(row, "review-forecast__hour-title", "flex: 0 0 100px", timeStr);
    createDiv(row, "review-forecast__increase-indicator", "font-weight: var(--font-weight-bold); text-align: center;", "Level Up!");
  }

  function addUnlockRow(root, timeStr, count, runningTotal, maxCount) {
    const row = createDiv(root, "review-forecast__hour");
    createDiv(row, "review-forecast__hour-title", "flex: 0 0 100px", timeStr);
    const barRoot = createDiv(row, "review-forecast__increase-indicator");
    createDiv(barRoot, "review-forecast__increase-bar", `width: ${(count / maxCount) * 100}%; background-color: var(--color-vocabulary);`);
    createDiv(row, "review-forecast__hour-increase review-forecast__increase", undefined, count);
    createDiv(row, "review-forecast__hour-total review-forecast__total", undefined, runningTotal);
  }

  function addVocabLessonBar() {
    // if (shared.recommendedVocabPerDay == 0) {
    if (shared.availableCount == 0 || shared.recommendedVocabPerDay == 0) {
      return;
    }

    const root = document.getElementsByClassName("todays-lessons")[0];
    if (root === undefined) {
      console.log("Lesson panel not found, can't add vocab bar");
      return;
    }

    const percentage = Math.min(1.0, shared.numVocabLearnedToday / shared.recommendedVocabPerDay);

    const outer = createDiv(root, "vocab-progress-bar");
    shared.lessonBarElement = outer;
    const bar = createDiv(outer, "vocab-progress-bar__progress", `width: ${percentage * 100}%`);
    if (percentage > 0.5) {
      createDiv(
        bar,
        "level-progress-bar__label level-progress-bar__label--inside",
        "line-height: 18px; font-size: 14px",
        `${shared.numVocabLearnedToday}/${shared.recommendedVocabPerDay} vocab`
      );
    } else {
      createDiv(
        outer,
        "level-progress-bar__label level-progress-bar__label",
        "line-height: 18px; font-size: 14px",
        `${shared.numVocabLearnedToday}/${shared.recommendedVocabPerDay} vocab`
      );
    }
    const icon = createDiv(bar, "level-progress-bar__icon", "flex: 0 0 18px");
  }
})();
