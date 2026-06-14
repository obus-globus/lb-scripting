// @ts-check
//
// boat-phase.js — a real-world community script (BoatPhase by "Sigma"),
// ported to LiquidBounce **nextgen** (MC 26.1.2) and type-checked against
// @wunk/lb-script-api-types.
//
// ── Why this is a useful example ───────────────────────────────────────────
// Unlike the other examples, this one reaches into raw Minecraft classes via
// `Java.type(...)` — sending packets, mutating the boat entity, reading key
// state. That's the pattern you need for anything the LB script bindings don't
// wrap directly. It also shows what `// @ts-check` does and doesn't cover here:
//
//   • Typed + checked: everything off the `mc` global — `mc.player`,
//     `mc.getConnection()`, `mc.options.keyJump`, the `event.packet`, the boat
//     `Entity` returned by `getVehicle()` (its method names are validated).
//   • NOT checked: the `Java.type(...)` handles below. `Java.type<T = any>`
//     returns `any`, so `new VehicleMove(...)` / `packet instanceof VehicleMove`
//     compile against `any` and don't narrow. Their FQCNs are validated by hand
//     against the generated `types/` tree, not by the compiler.
//
// ── What changed in the port (it was written for *legacy* LiquidBounce) ─────
// Legacy LB used **Yarn** mappings; nextgen uses **Mojang** mappings, so every
// class name and almost every method/field name changed, e.g.:
//   net.minecraft.util.math.Vec3d                     -> world.phys.Vec3
//   ...packet.c2s.play.VehicleMoveC2SPacket           -> protocol.game.ServerboundMoveVehiclePacket
//   entity.getPos()/getVelocity()/getYaw()/isOnGround() -> position()/getDeltaMovement()/getYRot()/onGround()
//   entity.noClip (field)                             -> entity.noPhysics (field)
//   mc.getNetworkHandler().sendPacket(p)              -> mc.getConnection().send(p)
//   mc.options.jumpKey.isPressed()                    -> mc.options.keyJump.isDown()
// Plus three things the typings flagged that were already drifted:
//   • setting reads use `.get()`, not `.value`
//   • the event is `"playerTick"` (camelCase), not `"playertick"`
//   • `mod.tag` is `string | null`, so the chosen mode is coerced with String()
//
// Nested Java classes are resolved with the canonical `$` separator.

const velocity = Java.type("net.minecraft.network.protocol.game.ClientboundSetEntityMotionPacket")
const ClientCommandC2SPacket = Java.type("net.minecraft.network.protocol.game.ServerboundPlayerCommandPacket")
const Mode = Java.type("net.minecraft.network.protocol.game.ServerboundPlayerCommandPacket$Action")
const TickEndC2S = Java.type("net.minecraft.network.protocol.game.ServerboundClientTickEndPacket")
const PlayerActionC2S = Java.type("net.minecraft.network.protocol.game.ServerboundPlayerActionPacket")
const Action = Java.type("net.minecraft.network.protocol.game.ServerboundPlayerActionPacket$Action")
const PlayerInteractItemC2SPacket = Java.type("net.minecraft.network.protocol.game.ServerboundUseItemPacket")
const HAND = Java.type("net.minecraft.world.InteractionHand")
const Pong = Java.type("net.minecraft.network.protocol.common.ServerboundPongPacket")
const Pos = Java.type("net.minecraft.network.protocol.game.ServerboundMovePlayerPacket$PosRot")
const Ground = Java.type("net.minecraft.network.protocol.game.ServerboundMovePlayerPacket$StatusOnly")
const VehicleMove = Java.type("net.minecraft.network.protocol.game.ServerboundMoveVehiclePacket")
const Paddle = Java.type("net.minecraft.network.protocol.game.ServerboundPaddleBoatPacket")
const Vec3d = Java.type("net.minecraft.world.phys.Vec3")
let movedVehicle = false
let ticks = 0
let spoof2 = false
let t = 0
let realticks = 0
let spoof = false
let lastvelocityX = 0
let lastvelocityZ = 0
const script = registerScript({
  name: "BoatPhase",
  version: "1.3",
  authors: ["Sigma"]
});

script.registerModule({
  name: "BoatPhase",
  description: "0 velocity = bypass",
  category: "Misc",
  settings: {
    noclip: Setting.choose({
      name: "Mode",
      default: "Grim v3",
      choices: ["Vulcan", "Grim v3", "Polar"]
    }),
    yawType: Setting.choose({
      name: "Look Yaw",
      default: "Boat",
      choices: ["Player", "Boat"]
    }),
    fall: Setting.boolean({
      name: "NoClip To Fall",
      default: false
    })

  }


}, (mod) => {
  // `mod.settings[key]` is typed `Value<Object>` (the index signature erases the
  // specific ChoiceListValue type), so `.get()` returns `Object`. These are
  // string choices, so coerce — otherwise `doNoClip == "Polar"` is a strict-mode
  // "no overlap" error. (A typings sharpening opportunity: per-key value types.)
  let doNoClip = String(mod.settings.noclip.get());
  let yawType = String(mod.settings.yawType.get())
  let Fall = mod.settings.fall.get()
  let sequence = 0
  mod.on("playerTick", () => {
    doNoClip = String(mod.settings.noclip.get());
    mod.tag = doNoClip
    // mc.player.onGround = true
    realticks++

    if (!mc.player.onGround()) {
      ticks++
    } else {
      ticks = 0
    }
  })

  mod.on("packet", (event) => {
    const packet = event.packet
    let yaw = 0



    if (packet instanceof VehicleMove) {
      const boat = mc.player.getVehicle()
      if (yawType == "Player") yaw = mc.player.getYRot()
      if (yawType == "Boat") yaw = boat.getYRot()
      const forward = 1e-7
      let xModifierthingy = 0
      let zModifierthingy = 0
      const yawRad = yaw * (Math.PI / 180);
      if (doNoClip == "Polar") {
        boat.noPhysics = true
        return
      }
      if (doNoClip == "Grim v3" && !spoof) {
          event.cancelEvent()

          if (Math.cos(yawRad) < 0) zModifierthingy = -1
          if (Math.cos(yawRad) >= 0) zModifierthingy = 1
          if (-Math.sin(yawRad) < 0) xModifierthingy = -1
          if (-Math.sin(yawRad) >= 0) xModifierthingy = 1
          let dx = forward * xModifierthingy;
          let dz = forward * zModifierthingy
          let dy = 0
          if (mc.options.keyJump.isDown()) {
            if (Fall) boat.noPhysics = true
            if (!Fall) dy = -1e-7
          } else {
            boat.noPhysics = false
          }
          movedVehicle = true
          spoof = true
          boat.setPos(boat.position().x + dx, boat.position().y + dy, boat.position().z + dz)
          mc.getConnection().send(VehicleMove.fromEntity(boat))
          spoof = false
          return
      }
      if (doNoClip == "Vulcan" && !spoof) {
          event.cancelEvent()
          const forwardVulcan = 0.2

          const dx = -Math.sin(yawRad) * forwardVulcan;
          const dz =  Math.cos(yawRad) * forwardVulcan;
          let dy = 1
          if (realticks % 5 == 1) {
            boat.setPos(boat.position().x + dx, boat.position().y + dy, boat.position().z + dz)
            boat.setDeltaMovement(boat.getDeltaMovement().x, 0, boat.getDeltaMovement().z)
          }
      }
    }



    if (packet instanceof PlayerInteractItemC2SPacket) {
      sequence = (/** @type {any} */ (packet)).sequence
    }
  })

  mod.on("disable", () => {
    if (mc.player.isPassenger()) {
      const boat = mc.player.getVehicle()
      if (boat == null) return
      boat.noPhysics = false
    }

  })




});
