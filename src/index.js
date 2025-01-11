import IntervalTree from "@flatten-js/interval-tree";
import { BinTree } from "bintrees";

const MAX_FETCH_LOGS = 5000;
const END_TIMES = 8640000000000000;
const WHOLE_TIME = [-END_TIMES, END_TIMES];

function unparseList(label, values) {
  const keys = Object.entries(values ?? {}).filter(([_key, value]) => value).map(([key]) => key);
  return keys.length
    ? label + "=" + keys.join(",")
    : "";
}

function unparseTags(_label, values) {
  const keys = Object.keys(values ?? {});
  return keys.length
    ? keys.map((key) => key + "=True").join("&")
    : "";
}

function unparseString(label, value) {
  return value ? label + "=" + value : "";
}

function unparseDate(label, value) {
  return unparseString(
    label,
    value ? (new Number(value) / 1000).toFixed(0) : 0,
  );
}

function unparseIdentity(label, value) {
  return value !== undefined ? label + "=" + value : "";
}

function noSelection(obj) {
  for (let key in obj)
    if (obj[key])
      return false;
  return true;
}

function matchTags(tags, item) {
  for (const tag in tags) {
    if (item[tag] !== undefined)
      continue;
    else
      return false;
  }
  return true;
}

function filterIdentity() {
  return true;
}

export const types = {
  enumeration: {
    default: {},
    unparse: unparseList,
    filter: function (field, filter, _item) {
      return filter[field] || noSelection(filter);
    },
  }, tags: {
    default: {},
    unparse: unparseTags,
    filter: function (_field, filter, item) {
      return matchTags(filter, item) || noSelection(filter);
    },
  }, string: {
    default: "",
    unparse: unparseString,
    filter: function (field, filter, _item) {
      return !filter || (field || "").includes(filter);
    },
  }, fromDate: {
    default: null,
    unparse: unparseDate,
    filter: function (field, filter, _item) {
      return !filter || field >= filter;
    },
  }, toDate: {
    default: null,
    unparse: unparseDate,
    filter: function (field, filter, _item) {
      return !filter || field <= filter;
    },
  }, limit: {
    default: MAX_FETCH_LOGS,
  },
};

let singleton = null;

export default class Logs {
  // change maximum to another number to limit the amount of kept logs
  constructor(options = {}) {
    if (singleton)
      return singleton;

    const {
      url,
      streamUrl,
      fetch = globalThis.fetch,
      stream = false,
      restInterval = 3000,
      fields = {},
      streamOpen = (streamUrl) => new WebSocket(streamUrl),
      limit = MAX_FETCH_LOGS,
      transform = a => a,
      streamTransform = msg => JSON.parse(msg ?? {}),
      types: optTypes = types,
      timeLabel = "timestamp",
    } = options;

    singleton = this;
    this.fetch = fetch;
    this.restInterval = restInterval;
    this.url = url;
    this.streamUrl = streamUrl;
    this.stream = stream;
    this.fields = {
      fromDate: { key: timeLabel },
      toDate: { key: timeLabel },
      limit: {},
      ...fields,
    };
    this.timeLabel = timeLabel;
    this.types = optTypes;
    this.streamOpen = streamOpen;
    this.limit = limit;
    this.transform = transform;
    this.streamTransform = streamTransform;
    this.init();
  }

  init() {
    this.subs = new Map();
    this.lastInterval = [];
    this.fetchingAbsent = false;
    this.beginning = -END_TIMES;
    this.unbound = 0;
    this.subscriptionTree = new IntervalTree();
    this.orphans = new BinTree((a, b) => a[this.timeLabel] - b[this.timeLabel]);
    this.orphanQueries = {};
    this.absentControllers = {};
    this.refresh();
  }

  getLastFrom() {
    return this.lastIntervalKey?.[0] ?? null;
  }

  getLastTo() {
    return this.lastIntervalKey?.[1] ?? null;
  }

  getParamString(params) {
    return Object.entries(this.fields).map(
      ([key, field]) => (
        this.types[field.type ?? key]?.unparse ?? unparseIdentity
      )(key, params[key])
    ).filter((a) => !!a).join("&");
  }

  async _getLogs(fromDate, toDate, orphanString = "") {
    const param = {
      ...(orphanString ? {} : { limit: this.limit }),
      fromDate,
      toDate,
    };
    const paramPrefix = this.getParamString(param);
    const path = this.url + "?" + paramPrefix
      + (paramPrefix && orphanString ? "&" : "")
      + orphanString;
    try {
      const data = await this.fetch(path) || [];
      const newLogs = data.map(this.transform);
      return newLogs;
    } catch (e) {
      console.info("@tty-pt/logs Logs._getLogs caught:", e);
      // delete this.orphanQueries[orphanString];
      return [];
    }
  }

  async refresh() {
    this.tree = new IntervalTree();
    this.update();

    if (this.stream) {
      const sock = this.streamOpen(this.streamUrl);
      sock.onmessage = (msg) => {
        const item = this.streamTransform(msg);
        this.pushInterval([this.transform(item, 0, [item], true)]);
        this.update();
      };

      this.shiftInterval(await this._getLogs(this.getLastTo(), null));
      this.update();
    }
    else this.getLogs();
  }

  removeIntersectingOrphans(intervalKey) {
    const removedOrphans = [];
    const [low, high] = intervalKey;
    let lastLow = low;
    let orphan = this.orphans.lowerBound({ [this.timeLabel]: lastLow }).data();

    // remove orphans intersecting interval
    while (orphan && orphan[this.timeLabel] <= high) {
      removedOrphans.push([orphan, lastLow, orphan[this.timeLabel]]);
      lastLow = orphan[this.timeLabel];
      this.orphans.remove(orphan);
      orphan = this.orphans.lowerBound({ [this.timeLabel]: lastLow }).data();
    }

    // if (removedOrphans.length)
    //   console.log("removed orphans", low, high, removedOrphans);
  }

  async getLogs() {
    try {
      if (!Object.keys(this.absentControllers).length) {
        const intervalValue = await this._getLogs(this.getLastTo(), null);

        if (intervalValue.length) {
          this.pushInterval(intervalValue);
          this.removeIntersectingOrphans(this.getKey(intervalValue));
          this.update();
        }
      }
    } catch (e) {
      console.info("@tty-pt/logs Logs.getLogs caught:", e);
    }
    setTimeout(() => this.getLogs(), this.restInterval);
  }

  get() {
    let total = [];
		const intervalIterator = this.tree.iterate();
		const binaryIterator = this.orphans.iterator();

    let intervalItem = intervalIterator.next();
    let binaryItem = binaryIterator.next();

		while (binaryItem && !intervalItem.done) {
      if (intervalItem.done || !(
        intervalItem.value[0][this.timeLabel] <= binaryItem[this.timeLabel]
      )) {
        total.push(binaryItem);
        binaryItem = binaryIterator.next();
      } else {
        total = intervalItem.value.concat(total);
        intervalItem = intervalIterator.next();
      }
    }

    while (binaryItem) {
      total.unshift(binaryItem);
      binaryItem = binaryIterator.next();
    }

    while (!intervalItem.done) {
			total = intervalItem.value.concat(total);
			intervalItem = intervalIterator.next();
		}

    return total;
  }

  getAbsentIntervals(fromTime, toTime = this.lastIntervalKey?.[0]) {
    if (!fromTime || fromTime === this.lastIntervalKey[0])
      return [];

    let absentStart = fromTime;
    const absentTimes = [];
    const presentTimes = [];

    for (const innerKey of this.tree.iterate(
      [fromTime, toTime],
      (_value, key) => key,
    )) {
      const { low, high } = innerKey;

      if (absentStart < low)
        absentTimes.push([absentStart, low, innerKey]);
      else
        presentTimes.push([low, high]);
      absentStart = high;
    }

    if (absentStart < toTime)
      absentTimes.push([absentStart, toTime]);

    // console.log("absent", absentTimes, "present", presentTimes, fromTime, this.getLastFrom());
    return absentTimes;
  }

  getKey(interval) {
    return [interval[interval.length - 1][this.timeLabel], interval[0][this.timeLabel]];
  }

  setLastInterval(interval, intervalKey) {
    if (!this.tree.isEmpty())
      this.tree.remove(this.lastIntervalKey, this.lastInterval);

    this.lastInterval = interval;
    this.lastIntervalKey = intervalKey;
    this.tree.insert(this.lastIntervalKey, interval);
  }

  shiftInterval(interval) {
    if (!interval.length)
      return;
    const key = this.getKey(interval);
    this.setLastInterval(this.lastInterval.concat(interval), [
      key[0],
      this.tree.isEmpty ? key[1] : this.getLastTo(),
    ]);
  }

  pushInterval(interval) {
    if (!interval.length)
      return;
    const key = this.getKey(interval);
    this.setLastInterval(interval.concat(this.lastInterval), [
      this.tree.isEmpty() ? key[0] : this.getLastFrom(),
      key[1],
    ]);
  }

  getFormattedKey(intervalKey) {
    const [start, end] = intervalKey;
    return [new Date(start).toISOString(), new Date(end).toISOString()];
  }

  // assumes the interval is really absent
  insertAbsent(intervalKey, interval) {
    const [fromDate, toDate] = intervalKey;

    for (const [innerInterval, key] of this.tree.iterate(
      intervalKey,
      (value, key) => [value, key],
    )) {
      this.tree.remove(key);

      if (key.high === fromDate) {
        return this.tree.insert(
          [key.low, toDate],
          interval.concat(innerInterval),
        );
      }

      if (key.low === toDate) {
        const possiblyLastKey = [interval.length ? this.getKey(interval)[0] : fromDate, key.high];
        const possiblyLast = innerInterval.concat(interval);

        if (key.high === this.lastIntervalKey[1])
          return this.setLastInterval(possiblyLast, possiblyLastKey, false);

        return this.tree.insert(possiblyLastKey, possiblyLast);
      }
    }

    if (this.lastIntervalKey[0] === toDate) {
      const possiblyLastKey = [interval.length ? this.getKey(interval)[0] : fromDate, this.lastIntervalKey[1]];
      const possiblyLast = this.lastInterval.concat(interval);
      return this.setLastInterval(possiblyLast, possiblyLastKey, false);
    } else
        return this.tree.insert(intervalKey, interval);
  }

  async fetchAbsent(fromDate, toDate, level, orphanString) {
    const absentIntervals = this.getAbsentIntervals(fromDate, toDate);

    if (!absentIntervals.length) {
      if (level === 0)
        delete this.absentControllers[orphanString];
      return;
    }

    if (level === 0)
      this.absentControllers[orphanString] = new AbortController();

    const allAbsent = await Promise.all(
      absentIntervals.map((interval) =>
        this._getLogs(interval[0], interval[1], orphanString, true).then((logs) => [interval, logs]),
      ),
    );

    if (!this.absentControllers[orphanString] || this.absentControllers[orphanString].signal.aborted)
      return;

    let absentFrom = fromDate;
    const newAbsent = [];
    let update = false;

    for (const [key, absent] of allAbsent) {
      if (absent.length) {
        const [realFrom, realTo] = this.getKey(absent);
        if (realFrom > absentFrom)
          newAbsent.push([absentFrom, realFrom]);
        absentFrom = realTo;
        update = true;
      } else
        absentFrom = key[1];
    }

    if (toDate > absentFrom)
      newAbsent.push([absentFrom, toDate]);

    for (const [key, absent] of allAbsent) {
      this.insertAbsent(key, absent);
      if (absent.length)
        this.removeIntersectingOrphans(this.getKey(absent));
    }

    if (update)
      this.update();

    await Promise.all(newAbsent.map(([from, to]) => this.fetchAbsent(from, to, level + 1, orphanString)));
    if (level === 0)
      delete this.absentControllers[orphanString];
  }

  filter(argQuery = {}) {
    const query = Object.entries(this.fields).reduce((a, [key, value]) => ({
      ...a,
      [key]: argQuery[key] ?? value.default,
    }), {});

    const ret = this.get().filter((item) => {
      for (const key in this.fields) {
        const field = this.fields[key];
        const filterType = field.type ?? key;
        const fieldKey = field.key ?? key;
        const filterFine = (
          this.types[filterType]?.filter ?? filterIdentity
        )(item[fieldKey], query[key], item);

        if (!filterFine)
          return false;
      }
      return true;
    });

    return ret;
  }

  collectIntersections(intervalKey) {
    let [fromDate, toDate] = intervalKey;
    const matches = [];

    for (const [value, key] of this.subscriptionTree.iterate(
      intervalKey,
      (value, key) => [value, key],
    )) {
      this.subscriptionTree.remove(key, value);

      // should work well in all expected situations
      if (key.low < fromDate) {
        if (fromDate < key.high) {
          matches.push([key.low, fromDate, value]);
          matches.push([fromDate, key.high, value + 1]);
        } else if (fromDate === key.high)
          matches.push([key.low, fromDate, value + 1]);
      } else if (toDate < key.high) {
        matches.push([key.low, toDate, value + 1]);
        matches.push([toDate, key.high, value]);
      } else
        matches.push([key.low, key.high, value + 1]);
    }

    return matches;
  }

  putSubscriptionInterval(intervalKey) {
    let [fromDate, toDate] = intervalKey;
    const matches = this.collectIntersections(intervalKey);

    if (!matches.length)
      return this.subscriptionTree.insert([fromDate, toDate], 1);

    for (const [innerFrom, innerTo, value] of matches)
      this.subscriptionTree.insert([innerFrom, innerTo], value);

    let lastTo = fromDate;
    for (const [innerFrom, innerTo] of matches) {
      if (innerFrom > lastTo)
        this.subscriptionTree.insert([lastTo, innerFrom], 1);
      lastTo = innerTo;
    }

    if (toDate > lastTo)
      this.subscriptionTree.insert([lastTo, toDate], 1);
  }

  delIntervals(range) {
    let last;

    for (const [value, key] of this.tree.iterate(range, (value, key) => [
      value,
      key,
    ])) {
      if (!this.subscriptionTree.intersect_any(key))
        this.tree.remove(key, value);
      last = [[key.low, key.high], value];
    }

    if (!this.tree.isEmpty())
      for (const [value, key] of this.tree.iterate(undefined, (value, key) => [
        value,
        key,
      ]))
        last = [[key.low, key.high], value];

    if (!last)
      return;

    let [key, value] = last;

    if (key[1] !== this.lastIntervalKey[1])
      return;

    if (value.length > MAX_FETCH_LOGS) {
      if (
        !this.subscriptionTree.intersect_any(key) ||
        (this.subscriptionTree.size === 1 && this.unbound === 0)
      )
        value = value.slice(0, MAX_FETCH_LOGS);

      key[0] = value[value.length - 1][this.timeLabel];
    }

    this.setLastInterval(value, key);
  }

  delSubscriptionInterval(intervalKey) {
    for (const [value, key] of this.subscriptionTree.iterate(
      intervalKey,
      (value, key) => [value, key],
    )) {
      this.subscriptionTree.remove(key, value);
      if (value - 1 > 0)
        this.subscriptionTree.insert(key, value - 1);
      else
        this.delIntervals([key.low, key.high]);
    }
  }

  delOrphans(orphanString) {
    const orphanQuery = this.orphanQueries[orphanString];

    if (!orphanQuery || orphanQuery.subs > 0)
      return;

    const orphans = orphanQuery.list;

    if (orphans && orphans.length)
      for (const orphan in orphans) {
        const treeOrphan = this.findExistingOrphan(orphan);
        treeOrphan.subs--;
        if (treeOrphan.subs <= 0)
          this.orphans.remove(orphan);
      }

    delete this.orphanQueries[orphanString];
  }

  delSubscriptionOrphans(orphanString) {
    this.orphanQueries[orphanString].subs--;
    this.delOrphans(orphanString);
  }

  findExistingOrphan(similarOne) {
    const it = this.orphans.lowerBound(similarOne);
    let node = it.data();

    while (node && node[this.timeLabel] === similarOne[this.timeLabel]) {
      let differs = false;
      const a = { ...node };
      delete a.subs;

      for (const [key, value] in Object.entries(a))
        if (similarOne[key] !== value) {
          differs = true;
          node = it.next(node); // Move to the next node in the tree
          break;
        }

      if (!differs)
        return node;
    }

    return null;
  }

  async fetchOrphans(fromDate, toDate, orphanString) {
    // console.log("fetchOrphans", fromDate, toDate, orphanString);
    const orphans = await this._getLogs(fromDate, toDate, orphanString);
    const orphanQuery = this.orphanQueries[orphanString];

    // cancel if subscription was removed meanwhile
    if (!orphanQuery || orphanQuery.subs <= 0 || orphanQuery.list?.length)
      return;

    for (const orphan of orphans) {
      const time = orphan[this.timeLabel];
      if (this.tree.intersect_any([time, time]))
        continue;

      const existingOrphan = this.findExistingOrphan(orphan);
      if (existingOrphan)
        existingOrphan.subs ++;
      else
        this.orphans.insert({ ...orphan, subs: 1 });
    }

    this.orphanQueries[orphanString].list = orphans;
    this.update();
  }

  subscribe(callback, outerQuery = {}) {
    let { fromDate, toDate, limit, ...rest } = outerQuery;

    if (!limit)
      this.unbound++;

    if (this.delSubIntTimeout)
      clearTimeout(this.delSubIntTimeout);

    if (this.delSubOrpTimeout)
      clearTimeout(this.delSubOrpTimeout);

		const key = [
			fromDate ? fromDate.getTime() : this.beginning,
			(toDate ? toDate.getTime() : null) || END_TIMES,
		];

		let orphanString;

    orphanString = this.getParamString({ limit: limit || this.limit, ...rest });

    if (!this.orphanQueries[orphanString])
      this.fetchOrphans(fromDate, toDate, orphanString);

    const orphanQuery = this.orphanQueries[orphanString] ?? { subs: 0 };
    orphanQuery.subs++;
    this.orphanQueries[orphanString] = orphanQuery;

    if (!limit) {
      // if fetching a non-limited interval but with a fromDate,
      // we want to fill in the missing spaces (because there still
      // might be a limit in the results)
      if (fromDate < this.getLastFrom() && !this.absentControllers[orphanString])
        this.fetchAbsent(fromDate ? fromDate.getTime() : null, (toDate ? toDate.getTime() : this.getLastFrom()), 0, orphanString);
      this.putSubscriptionInterval(key);
    }

    this.subs.set(callback, true);
    return () => {
      if (!limit)
        this.unbound--;

      this.delSubOrpTimeout = setTimeout(() => this.delSubscriptionOrphans(orphanString), 0);

      if (!limit)
        this.delSubIntTimeout = setTimeout(() => this.delSubscriptionInterval(key), 0);

      this.subs.delete(callback);
    };
  }

  update() {
    const logs = this.get();

    if (logs.length)
      this.beginning = logs[logs.length - 1][this.timeLabel];

    if (
      this.beginning !== -END_TIMES &&
      this.subscriptionTree.exist(WHOLE_TIME, 1)
    ) {
      this.subscriptionTree.remove(WHOLE_TIME, 1);
      this.subscriptionTree.insert([this.beginning, END_TIMES], 1);
    }

    for (const [sub] of this.subs)
      sub(logs);
  }
}

globalThis.Logs = Logs;
