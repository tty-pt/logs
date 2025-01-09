import IntervalTree from "@flatten-js/interval-tree";
import { BinTree } from "bintrees";

const MAX_FETCH_LOGS = 20000;
const END_TIMES = 8640000000000000;
const WHOLE_TIME = [-END_TIMES, END_TIMES];

function unparseList(label, values) {
  const keys = Object.keys(values ?? {});
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
      const sock = this.streamOpen();
      sock.onmessage = (msg) => {
        const item = this.streamTransform(msg);
        this.pushInterval([this.transform(item, 0, [item], true)], true);
        this.update();
      };

      this.shiftInterval(await this._getLogs(this.getLastTo(), null));
      this.update();
    }
    else this.getLogs();
  }

  removeIntersectingOrphans(intervalValue) {
    if (!intervalValue.length)
      return;

    const removedOrphans = [];
    const [low, high] = this.getKey(intervalValue);
    let lastLow = low;
    let orphan = this.orphans.lowerBound({ [this.timeLabel]: lastLow }).data();

    // remove orphans intersecting interval
    while (orphan && orphan[this.timeLabel] <= high) {
      removedOrphans.push([orphan, lastLow, orphan[this.timeLabel]]);
      lastLow = orphan[this.timeLabel];
      this.orphans.remove(orphan);
      orphan = this.orphans.lowerBound({ [this.timeLabel]: lastLow }).data();
    }

    if (removedOrphans.length)
      console.log("removed orphans", low, high, removedOrphans);
  }

  async getLogs() {
    try {
      const intervalValue = await this._getLogs(this.getLastTo(), null);

      if (intervalValue.length) {
        this.pushInterval(intervalValue);
        this.removeIntersectingOrphans(intervalValue);
        this.update();
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

  getAbsentIntervals(fromTime, toTime = this.lastIntervalKey?.[1]) {
    if (!fromTime)
      return [];

    let absentStart = fromTime;
    const absentTimes = [];

    for (const innerKey of this.tree.iterate(
      [fromTime, toTime],
      (_value, key) => key,
    )) {
      const { low, high } = innerKey;

      if (absentStart < low)
        absentTimes.push([absentStart, low]);
      absentStart = high;
    }

    if (absentStart < toTime)
      absentTimes.push([absentStart, toTime]);
    return absentTimes;
  }

  getKey(interval) {
    return [interval[interval.length - 1][this.timeLabel], interval[0][this.timeLabel]];
  }

  setLastInterval(interval, intervalKey) {
    if (this.lastInterval.length)
      this.tree.remove(this.lastIntervalKey, this.lastInterval);

    this.lastInterval = interval;
    this.lastIntervalKey = intervalKey ?? this.getKey(interval);
    this.tree.insert(this.lastIntervalKey, interval);
  }

  shiftInterval(interval) {
    this.setLastInterval(this.lastInterval.concat(interval));
  }

  pushInterval(interval) {
    this.setLastInterval(interval.concat(this.lastInterval));
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

      if (key.high === fromDate)
        return this.tree.insert(
          [key.low, toDate],
          interval.concat(innerInterval),
        );

      if (key.low === toDate) {
        const possiblyLastKey = [fromDate, key.high];
        const possiblyLast = innerInterval.concat(interval);

        if (innerInterval === this.lastInterval)
          return this.setLastInterval(possiblyLast, possiblyLastKey, false);

        return this.tree.insert(possiblyLastKey, possiblyLast);
      }
    }

    if (intervalKey[1] === this.lastIntervalKey[1])
      this.tree.insert(intervalKey, interval);
  }

  async fetchAbsent(fromDate, toDate) {
    if (this.fetchingAbsent)
      return;

    fromDate = fromDate ? fromDate.getTime() : null;
    toDate = (toDate ? toDate.getTime() : null) || this.getLastFrom();

    const absentIntervals = this.getAbsentIntervals(fromDate, toDate);

    if (!absentIntervals.length)
      return;

    this.fetchingAbsent = true;

    const allAbsent = await Promise.all(
      absentIntervals.map((interval) =>
        this._getLogs(interval[0], interval[1]).then((logs) => [interval, logs]),
      ),
    );

    for (const [key, absent] of allAbsent) {
      this.insertAbsent(key, absent);
      this.removeIntersectingOrphans(absent);
    }

    if (allAbsent.length)
      this.update();

    this.fetchingAbsent = false;
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
        setTimeout(() => this.delIntervals([key.low, key.high]), 0);
    }
  }

  delOrphans(orphanString) {
    const orphanQuery = this.orphanQueries[orphanString];

    if (!orphanQuery || orphanQuery.subs > 0)
      return;

    const orphans = orphanQuery.list;

    if (orphans && orphans.length)
      for (const orphan in orphans)
        this.orphans.remove(orphan);

    delete this.orphanQueries[orphanString];
  }

  delSubscriptionOrphans(orphanString) {
    this.orphanQueries[orphanString].subs--;
    setTimeout(() => this.delOrphans(orphanString), 1000);
  }

  async fetchOrphans(fromDate, toDate, orphanString) {
    const orphans = await this._getLogs(fromDate, toDate, orphanString);
    const orphanQuery = this.orphanQueries[orphanString];

    // cancel if subscription was removed meanwhile
    if (!orphanQuery || orphanQuery.subs <= 0 || orphanQuery.list?.length)
      return;

    for (const orphan of orphans) {
      const time = orphan[this.timeLabel];
      if (!this.tree.intersect_any([time, time]))
        this.orphans.insert(orphan);
    }

    this.orphanQueries[orphanString].list = orphans;
    this.update();
  }

  subscribe(callback, outerQuery = {}) {
    let { fromDate, toDate, limit, ...rest } = outerQuery;

    if (!limit)
      this.unbound++;

		const key = [
			fromDate ? fromDate.getTime() : this.beginning,
			(toDate ? toDate.getTime() : null) || END_TIMES,
		];

		let orphanString;

    if (limit) {
      orphanString = this.getParamString({ limit: limit || this.limit, ...rest });

      if (!this.orphanQueries[orphanString])
        this.fetchOrphans(fromDate, toDate, orphanString);

      const orphanQuery = this.orphanQueries[orphanString] ?? { subs: 0 };
      orphanQuery.subs++;
      this.orphanQueries[orphanString] = orphanQuery;
    } else {
      this.fetchAbsent(fromDate, toDate);
      this.putSubscriptionInterval(key);
    }

    this.subs.set(callback, true);
    return () => {
      if (!limit)
        this.unbound--;

      if (orphanString)
        this.delSubscriptionOrphans(orphanString);
      else
        this.delSubscriptionInterval(key);

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
