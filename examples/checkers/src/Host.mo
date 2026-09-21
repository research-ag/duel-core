// Host actor for checkers. This file barely ever changes between games —
// it forwards `status` as a plain query and wires `mo:duel-game-core/ws`
// for every mutating call. Copy verbatim; the only per-game line is the
// `Rules` import. Wires a multi-table LOBBY, not a single fixed board —
// anyone may open a table (open, or access-code protected to share with
// a friend out of band), and any number run independently and
// simultaneously; this game's own code never has to know or care.

import Time "mo:core/Time";

import TP "mo:duel-game-core";
import Registry "mo:duel-game-core/registry";
import Ws "mo:duel-game-core/ws";
import ActorMixin "mo:duel-game-core/actor_mixin";
import IcWebSocketCdkTypes "mo:ic-websocket-cdk/Types";
import PT "mo:promtracker";
import Http "mo:promtracker/mixins/http";
import Tracker "mo:promtracker/Tracker"; // enables pt.toValue() dot notation

import Rules "CheckersRules";

persistent actor {
  let pt = PT.Tracker.new();
  transient let renderer = PT.Renderer();
  renderer.addValue(PT.allSystemMetrics);
  renderer.addValue(pt.toValue());

  let registry : TP.Registry<Rules.State, Rules.Action> = Registry.new(60_000_000_000, 15_000_000_000); // 60s idle timeout, 15s claim-win window, per table
  registry.attachMetrics(pt);

  public query func status(sid : Text) : async TP.SessionStatus<Rules.State> {
    registry.status(Rules.spec(), Time.now(), sid);
  };

  transient let wsHub : Ws.Hub = Ws.createHub();
  transient let attached = Ws.attach<system, Rules.State, Rules.Action>(
    Rules.spec(),
    registry,
    wsHub,
    {
      encode = func(m : Ws.Msg<Rules.State, Rules.Action>) : Blob = to_candid (m);
      decode = func(b : Blob) : ?Ws.Msg<Rules.State, Rules.Action> = from_candid (b);
    },
    IcWebSocketCdkTypes.WsInitParams(null, ?65_000),
  );
  attached.ws.init<system>();

  // `attached.sweep` (not a bare `registry.sweep(Time.now())`)
  // pushes a fresh status to every session the idle sweep just evicted.
  include ActorMixin<system>(attached.ws, attached.sweep);

  include Http(renderer.renderExposition, "/metrics");
};
