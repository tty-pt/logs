# @tty-pt/logs
> We don't need no - data structures. Pam pam pam pam.
> No custom implementations - in the classroom.
> Engeneers don't - reinvent the weel

# Intro
There are many libraries that deal with writing logs to the backend.
And many others to present them.
Unfortunately or fortunately, I did't know of any that matched MOV.AI's requirements.
Something that could keep the logs updated in a central place, without having to burden the maintainer or developer with a hard job.

This is what came out of me wanting to find a solution.

It combines an "interval tree" and a normal binary search tree into one data structure that fits our needs. While meanwhile making the everyday's developer job as easy as "I'm interested in logs like these".

You can fetch logs any way you want, stream, do it over intervals.. Whatever.

But you won't have to do it for every card. Just do it once in a central place.
And every place needing them can request this API.

It's smart enough to know how to handle it.

## Usage

```es6
// firstly, we inherit the base class:

export default class MyLogs extends Logs {
  static CONSTANTS = {
    DEFAULT_LEVELS,
    DEFAULT_SERVICE,
  };

  constructor() {
    super({
      url: 'v1/logs/',
      transform,

      stream: true,
      streamUrl: "/ws/logs",
      streamTransform,

      fields: {
        level: { type: "enumeration", default: DEFAULT_LEVELS },
        service: { type: "enumeration", default: DEFAULT_SERVICE },
        tags: { type: "tags" },
        message: { type: "string" },
        robot: { type: "enumeration" },
      },
    });
  }
}

// we also implement a simple hook to use the class more easily in react:
export function useLogs(myQuery, dependencies) {
  const logs = new MyLogs();

  const getFiltered = useCallback(
    ({ limit = 0, ...query }) => logs.filter(query).slice(0, limit),
    [],
  );

  const [logsData, setLogsData] = useState(getFiltered(myQuery));

  useEffect(
    () => {
      setLogsData(getFiltered(myQuery));
      return logs.subscribe(() => setLogsData(getFiltered(myQuery)), myQuery);
    },
    dependencies,
  );

  return logsData;
}

// then, in a component, we do:
const filteredLogs = useLogs(
  {
    level: levels,
    service,
    tags,
    message,
    robot: robots,
    fromDate: selectedFromDate,
    toDate: selectedToDate,
  },
  [levels, service, tags, message, robots, selectedFromDate, selectedToDate],
);

// or even:
const { robot } = props;
const logsData = useLogs(
  {
    robot: {
      [robot.name]: true,
    },
    tags: {
      ui: true,
    },
    level: {
      "INFO": true,
    }
    limit: 2,
  },
  [robot.name],
);
```

And that's all you need.

## Options

### url
The url to fetch the initial list of past logs.

### fetch
A function (assumed async) to fetch a selection of logs based on an url parameter.

**default**: async (url) => (await fetch(url)).json()

### transform
A function that transforms items from a fetch response into what we store.

**default**: log => log

**signature**:
  - log: the item to transform
  - index: the index of the item in the received data
  - array: the full array of data to be added
  - isStream: a boolean that identifies if it came from the stream

### stream
A boolean that indicates if we will do real-time streaming or not (if not, we can still use fetch requests over an interval).

**default**: false

### streamUrl
A url to use to open a stream (for example a websocket stream). This is used for keeping logs up to date real-time.

### streamOpen
A function that opens a stream connection. It should return an object with an "onmessage" property that is a function that will get called for every new log that is received over this connection.

**default**: streamUrl => new WebSocket(streamUrl)

### streamTransform
This is a function that runs for each log message received in the "onmessage" I just mentioned. Then it passes the result to the "transform" function.

**default**: log => log

**signature**:
  - log: the item to transform

### fields
This is an object that identifies the fields present in each log. So that we know how to filter them.

#### type
A string that identifies the type of field (see "types" below).

#### default
The default value for the filter of the type

### restInterval
The number of milliseconds to wait before fetching new logs (when not using a stream).

**default**: 3000

### limit
The limit of logs we get in each request.
Also the amount we get in the initial one.

**default**: 20000

### timeLabel
A string that identifies the key of the log that has a timestamp.

**default**: timestamp

### types
An object with type information that tells us how to process the types of fields.

#### default
The default filter value

#### unparse
A function that says how to turn a filter into an URL parameter

**signature**:
  - label: the label of the url parameter
  - value: the value of the filters being queried

#### filter
How to filter over a field of this type

**signature**:
  - field: the value of the specific field in a log
  - filter: the value of the specific filter
  - item: the whole log item

## Default types

### string
This field must (partially) match a string.

- In an item: { message: "hello world" }
- In a query: { message: "hello" }
- As a parameter string: "message=hello"

**default**: ""

### enumeration
Represents a set of possible values.

- In an item: { timestamp: 33, level: "INFO" }
- In a query: { level: { "INFO": true, "WARNING": true } }
- As a parameter string: "level=INFO,WARNING"

**default**: {}

### tags
A field that an item must have.

- In item: { timestamp: 33, ui: "hello" }
- In a query: { tags: { "ui": true, "iu": true } }
- As a parameter string: "ui=True,iu=True"

**default**: {}

### fromDate
A date the item's field must be greater than

- In item: { timestamp: 33 }
- In a query: { fromDate: new Date() }
- As a parameter string: "fromDate=1736357786000"

**default**: null

### toDate
A date the item's field must be smaller than

- In item: { timestamp: 33 }
- In a query: { toDate: new Date() }
- As a parameter string: "toDate=1736357786000"

**default**: null

### limit
Just a default type for the limit.

- In item: (doesn't apply)
- In a query: { limit: 2 }
- As a parameter string: "limit=2"

**default**: 20000

# Aknowledgements
This came from [here](https://github.com/MOV-AI/frontend-npm-lib-core/blob/FP-3066-fleetboard-logs-of-the-workers-are-stored-in-the-manager-but-the-fleetboard-is-not-able-to-display-them-correctly/src/api/Logs/index.js).
