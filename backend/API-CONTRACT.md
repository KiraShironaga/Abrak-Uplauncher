# Local backend module contract

This is a new, isolated local test implementation for the recovered launcher UI.
The UI bundles and assets are preserved separately from generated local state.

Modules export `register(router)` and optionally `seed(state)`.

Router registration: `router.get(path, handler, options)`, `.post`, `.put`, `.patch`,
`.delete`. Paths accept `:id` and final optional `:id?`; RegExp is also accepted.
Static path segments have priority over dynamic ones. Options: `{auth:true}` or
`{admin:true}`. Admin prefix routes always require an authenticated admin.

Handlers receive `ctx` and return the exact JSON shape read by the recovered UI.
Do not wrap everything in `{data:...}`: axios already supplies response.data.
Context fields: `body`, `query`, `params`, `user`, `state`, `services`, `req`.
Methods: `requireUser()`, `requireAdmin()`, `fail(status,message)`,
`json(data,status=200)`, `html(text,status=200)`, `redirect(url)`, `url(path)`.

Persistent JSON buckets in SQLite:
`state.list(bucket)`, `state.get(bucket,id)`, `state.put(bucket,record)`,
`state.patch(bucket,id,partial)`, `state.delete(bucket,id)`, `state.nextId(bucket)`,
`state.transaction(syncCallback)`, `state.meta(key,defaultValue)`,
`state.setMeta(key,value)`. put assigns a numeric id if absent and returns saved
record. Reads return independent objects. transaction callbacks must be synchronous.

Shared buckets: users, gameAccounts, players, items, monsters, products, inventory,
orders. Root seeds users admin id1 and player id2; gameAccounts id1/id2 own the
matching user_id; players id1-3 use game account1 and id4-6 game account2.
User records expose id,name,email,role_id,beta,rush,kamas,ogrines,ogrines_linked,
arcanes,jetons and notification settings. Players carry user_id,account_id,server_id,
name,level,class_id,sex,colors and equipment-related structures as required by UI.

services.emit(userId,eventName,payload) publishes local Pusher-compatible events.
services.origin is the loopback HTTP origin. No real external APIs/payments/messages.
All financial and external-provider flows must visibly identify local test mode.
Do not silently implement an unrecognized operation as successful empty data.

Inspect actual recovered callsites/response consumers and implement persistent
behavior, validation, ownership and useful errors. Each module should export an
acceptanceCases array of request definitions if useful for HTTP verification.
