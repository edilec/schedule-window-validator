# Schedule Window Validator

Validate an exported job schedule against local operating hours, holidays, deadlines, and required upstream jobs. It reads local documents, expands bounded real UTC minutes through an explicit IANA time zone, and never starts or changes a job.

## Run

```sh
node bin/schedule-window-validator.mjs --root examples --schedule passing.json --policy policy.json
node bin/schedule-window-validator.mjs --root examples --schedule failing.json --policy policy.json --human
npm run check
```

`--root` declares the evidence directory. `--schedule` and `--policy` are relative paths within it. Optional `--out report.json` writes a copy of stdout inside that root after alias and symlink checks. JSON always goes to stdout; `--human` adds a brief summary to stderr. `--help` lists options.

## Documents and rules

A schedule has a nonempty `jobs` array. Each job has a nonempty opaque `id`, minute-aligned UTC `startUtc` and `endUtc` timestamps (`YYYY-MM-DDTHH:mm:00Z`), and a `dependsOn` array of job IDs. Optional `deadlineUtc` uses the same timestamp form. Ends must follow starts. A dependency must finish at or before its dependent job starts. A job must end at or before its deadline.

A policy has exactly `timeZone` (an IANA zone), `hours`, and `holidays`. `hours` has keys `0` through `6` for Sunday through Saturday. Each value is an array of windows `{ "start": "HH:mm", "end": "HH:mm" }`. Starts are inclusive and ends exclusive; `start` later than `end` continues into the next local day. Equal endpoints are invalid. `holidays` is an array of local `YYYY-MM-DD` dates; any job minute on one is blocked. The policy is configuration: unknown keys, invalid zones, or invalid windows exit 2 with empty stdout.

The tool evaluates each real UTC minute and maps it into local time. Thus the nonexistent spring-forward hour cannot be scheduled, while both occurrences of a fall-back hour follow the same declared local window. Overnight windows retain the day on which they started, but a holiday blocks minutes on its own local date.

| Rule | Severity and outcome | Meaning |
| --- | --- | --- |
| `input-unreadable`, `input-invalid`, `job-invalid`, `job-duplicate` | error, incomplete | Schedule is unreadable, malformed, empty, or has ambiguous job evidence |
| `dependency-unknown` | error, incomplete | Required upstream job is absent or ambiguous |
| `byte-limit`, `record-limit`, `depth-limit`, `duration-limit`, `expansion-limit`, `time-limit` | error, incomplete | A processing bound was exceeded |
| `outside-hours`, `holiday-blocked` | error, fail | A job runs outside local hours or on a holiday |
| `deadline-missed`, `dependency-late` | error, fail | A deadline or upstream finish time blocks the job |

Reports use `schemaVersion: "1"`, `tool`, `status`, `summary`, and sorted `findings`. Findings use the fixed logical source role `@schedule`, not a host path, and JSON pointers into the exact schedule file named at invocation. Job IDs, policy names, paths, and source payloads are never copied into findings. Exit `0` means evaluated and pass; `1` means evaluated and failed; `2` means incomplete evidence, invalid configuration, or write failure. Invalid configuration has empty stdout; unreadable schedule evidence produces an `incomplete` JSON report.

Limits: 1,048,576 bytes per input, 1,000 jobs, JSON nesting depth 16, 10,080 minutes per job, 100,000 total expanded minutes, and 5,000 ms evaluation time. A policy permits at most 366 holiday dates and eight windows per weekday; a job permits at most 1,000 dependency references. The exact limit is accepted, and the next unit is refused. Reads resolve real paths inside `--root`; optional report output cannot overwrite or alias either input.

The tool does not parse cron, infer a time zone, account for capacity, or promise a job will run. It does not make network or provider calls. MIT license; see [LICENSE](./LICENSE).
