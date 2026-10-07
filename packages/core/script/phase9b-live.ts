import { Effect } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { LocationServiceMap } from "../src/location-services"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { SessionV2 } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionExecutionLocal } from "../src/session/execution/local"
import { Prompt } from "../src/session/prompt"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"

const [directory, model, text] = process.argv.slice(2)
if (!directory || !model || !text) throw new Error("Expected disposable directory, installed model, prompt")
const services = AppNodeBuilder.build(LayerNode.group([SessionV2.node, LocationServiceMap.node]), [
  [SessionExecution.node, SessionExecutionLocal.node],
])
await Effect.runPromise(
  Effect.gen(function* () {
    const sessions = yield* SessionV2.Service
    const session = yield* sessions.create({
      location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      model: ModelV2.Ref.make({ providerID: ProviderV2.ID.make("memory-local"), id: ModelV2.ID.make(model) }),
    })
    yield* sessions.prompt({ sessionID: session.id, prompt: Prompt.make({ text }), resume: false })
    yield* sessions.resume(session.id)
    console.log("V2 CONTEXT", JSON.stringify(yield* sessions.context(session.id)))
  }).pipe(Effect.scoped, Effect.provide(services)),
)
