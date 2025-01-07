import IntervalTree from "@flatten-js/interval-tree";

const MAX_FETCH_LOGS = 20000;
const END_TIMES = 8640000000000000;
const WHOLE_TIME = [-END_TIMES, END_TIMES];

function unparseList(label, values) {
  return values?.length
    ? label + "=" + values.map((el) => el.label).join()
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
    unparse: unparseList,
    filter: function (_field, filter, item) {
      return matchTags(filter, item) || noSelection(filter);
    },
  }, string: {
    default: "",
    unparse: unparseString,
    filter: function (field, filter, _item) {
      return (field || "").includes(filter);
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
      fetch = globalThis.fetch,
      streaming = false,
      restInterval = 3000,
      fields = {},
      open = () => {},
      limit = MAX_FETCH_LOGS,
      transform = a => a,
      streamTransform = a => a,
      types: optTypes = types,
    } = options;

    singleton = this;
    this.fetch = fetch;
    this.restInterval = restInterval;
    this.url = url;
    this.streaming = streaming;
    this.fields = {
      fromDate: {},
      toDate: {},
      limit: {},
      ...fields,
    };
    this.types = optTypes;
    this.open = open;
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
      )(key, params[field.key ?? key])
    ).filter((a) => !!a).join("&");
  }

  async _getLogs(params) {
    const path = this.url + "?"
      + this.getParamString({ limit: this.limit, ...params });

    const response = await this.fetch(path);
    const data = response?.data || [];
    const newLogs = data.map(this.transform);
    return newLogs;
  }

  async refresh() {
    this.tree = new IntervalTree();
    this.update();

    if (this.streaming) {
      const sock = this.open();
      sock.onmessage = (msg) => {
        const item = this.websocketTransform(JSON.parse(msg?.data ?? {}));
        this.pushInterval([this.transform(item, 0, [item], 0.000001)], true);
        this.update();
      };

      this.shiftInterval(await this._getLogs({
        fromDate: this.getLastTo(),
        toDate: null,
      }));

      this.update();
    } else
      this.getLogs();
  }

  async getLogs() {
    try {
      this.pushInterval(await this._getLogs({
        fromDate: this.getLastTo(),
        toDate: null,
      }));
      this.update();
    } catch (e) {
      console.log("Failed getting logs", e);
    }
    setTimeout(() => this.getLogs(), this.restInterval);
  }

  get() {
    let total = [];
    if (!this.lastInterval.length)
      return [];

    for (const innerInterval of this.tree.iterate())
      total = innerInterval.concat(total);

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
    return [interval[interval.length - 1].timestamp, interval[0].timestamp];
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
        this._getLogs({
          fromDate: interval[0],
          toDate: interval[1],
        }).then((logs) => [interval, logs]),
      ),
    );

    for (const [key, absent] of allAbsent)
      this.insertAbsent(key, absent);

    if (allAbsent.length)
      this.update();

    this.fetchingAbsent = false;
  }

  filter(argQuery = {}) {
    const query = Object.entries(this.fields).reduce((a, [key, value]) => ({
      ...a,
      [key]: argQuery[key] ?? value.default,
    }), {});

    return this.get().filter((item) => {
      for (const key in this.fields) {
        const field = this.fields[key];
        const filterType = field.type ?? key;
        const fieldKey = field.key ?? key;
        if (!(
          this.types[filterType]?.filter ?? filterIdentity
        )(item[key], query[fieldKey], item)) {
          return false;
        }
      }
      return true;
    });
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

      key[0] = value[value.length - 1].timestamp;
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

  subscribe(callback, outerQuery = {}) {
    const { fromDate, toDate, limit } = outerQuery;

    if (!limit)
      this.unbound++;

    this.fetchAbsent(fromDate, toDate);

    const key = [
      fromDate ? fromDate.getTime() : this.beginning,
      (toDate ? toDate.getTime() : null) || END_TIMES,
    ];

    this.putSubscriptionInterval(key);

    this.subs.set(callback, true);
    return () => {
      if (!limit)
        this.unbound--;

      this.delSubscriptionInterval(key);
      this.subs.delete(callback);
    };
  }

  update() {
    const logs = this.get();

    if (logs.length)
      this.beginning = logs[logs.length - 1].timestamp;

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
