## What this changes and why

## How it was checked
- [ ] `npm run typecheck && npm test`
- [ ] `npm run smoke` and `npm run smoke:workers`
- [ ] Python tests, if `python/` changed
- [ ] A test fails without this change

## Does it touch what is kept or sent?
- [ ] No new dependency
- [ ] No prompt or answer is logged, cached (for a `private` call) or sent anywhere new
