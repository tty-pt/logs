# @tty-pt/logs
> We don't need no - data structures. Pam pam pam pam.
> No custom implementations - in the classroom.
> Engeneers don't - reinvent the weel

Made the logs implementation [here](https://github.com/MOV-AI/frontend-npm-lib-core/blob/FP-3066-fleetboard-logs-of-the-workers-are-stored-in-the-manager-but-the-fleetboard-is-not-able-to-display-them-correctly/src/api/Logs/index.js) generic enough for N use-cases.

## Description

Real time log fetch that is very flexible and actually allows for the use-cases that mov.ai needs.

We know how to get all kinds of logs, all kinds of ways! Rest... WebSockets...

And query them efficiently in a centralized fashion!

No more 3-second interval fetching for each of 10 cards.
