// Entry point — wires every service together by hand (this app has no DI
// framework) and starts the race once duel-game-core's chrome (see
// duel/duel-app.js and index.html's #screen) reports the canister session
// has actually reached #inGame. Construction order below matters (each
// service takes its dependencies as constructor arguments).

import { GameStateService } from './app/modules/gameplay/game-shared/services/game-state.service';
import { ViewportService } from './app/modules/gameplay/game-viewport/services/viewport.service';
import { ThreeRenderingService } from './app/modules/gameplay/game-viewport/services/three-rendering.service';
import { DisplayService } from './app/modules/gameplay/game-viewport/services/display.service';
import { VehiclePhysicsService } from './app/modules/gameplay/game-physics/services/vehicle-physics.service';
import { GamePhysicsService } from './app/modules/gameplay/game-physics/services/game-physics.service';
import { ShaderLoaderService } from './app/modules/gameplay/game-resources/services/shader-loader.service';
import { ModelLoaderService } from './app/modules/gameplay/game-resources/services/model-loader.service';
import { MapLoaderService } from './app/modules/gameplay/game-resources/services/map-loader.service';
import { CarLoaderService } from './app/modules/gameplay/game-resources/services/car-loader.service';
import { PlayerViewService } from './app/modules/gameplay/gameplay/services/player-view.service';
import { WorldSceneService } from './app/modules/gameplay/game-rendering/services/scenes/world-scene.service';
import { ControlSceneService } from './app/modules/gameplay/game-rendering/services/scenes/control-scene.service';
import { LobbyConnectionService } from './app/modules/gameplay/game-communication/services/lobby-connection.service';
import { PlayerControlService } from './app/modules/gameplay/gameplay/services/player-control.service';
import { GameplayService } from './app/modules/gameplay/gameplay/services/gameplay.service';
import { Hud } from './app/modules/gameplay/game-viewport/hud/hud';

const gameStateService = new GameStateService();
const viewportService = new ViewportService();
const threeRenderingService = new ThreeRenderingService();
const displayService = new DisplayService(viewportService, threeRenderingService);
const vehiclePhysicsService = new VehiclePhysicsService();
const gamePhysicsService = new GamePhysicsService(vehiclePhysicsService);
const shaderLoaderService = new ShaderLoaderService();
const modelLoaderService = new ModelLoaderService(shaderLoaderService);
const mapLoaderService = new MapLoaderService(modelLoaderService);
const carLoaderService = new CarLoaderService(modelLoaderService);
const playerViewService = new PlayerViewService(gameStateService, vehiclePhysicsService, viewportService);
const worldSceneService = new WorldSceneService(playerViewService, gameStateService, carLoaderService, displayService);
const controlSceneService = new ControlSceneService(playerViewService, gameStateService, displayService);
const lobbyConnectionService = new LobbyConnectionService(gameStateService);
const playerControlService = new PlayerControlService(vehiclePhysicsService, viewportService, gameStateService, controlSceneService, playerViewService);
const gameplayService = new GameplayService(gameStateService, lobbyConnectionService, mapLoaderService, carLoaderService, gamePhysicsService, playerControlService, worldSceneService, controlSceneService);
const hud = new Hud(gameStateService);

const stage = document.getElementById('game-stage');
if (!stage) {
  throw new Error('main.ts: #game-stage element is missing from index.html');
}
displayService.initDisplay(stage);

const hudContainer = document.getElementById('hud');
if (!hudContainer) {
  throw new Error('main.ts: #hud element is missing from index.html');
}
hud.mount(hudContainer);

// Fires once for the very first race (including a page reload landing
// back in a race already under way) and again on every rematch (see
// LobbyConnectionService.raceStarted's doc). Scene/map setup only ever
// runs once (sceneInitialized guard); every emission — including the
// first — resets and (re)starts the actual race via startRace(), passing
// through `resumedAtStep` (seeds the HUD clock/step counter from the
// TRUE current round instead of restarting them from 0) and
// `youAlreadySubmitted` (skips asking for a second move when reconnecting
// mid-round with one already locked in server-side).
let sceneInitialized = false;
lobbyConnectionService.connectToLobby().subscribe(async ({ resumedAtStep, youAlreadySubmitted }) => {
  if (!sceneInitialized) {
    sceneInitialized = true;
    await gameplayService.init();
  }

  // Wait for the map to finish loading and our own car to exist before
  // showing anything. On the first race this waits for real asset loads;
  // on a rematch it resolves on the same tick, since the map is already
  // loaded and lobby-connection.service.ts already pushed fresh Car
  // instances before firing raceStarted.
  await new Promise<void>((resolve) => {
    const check = () => {
      const mapLoaded = !!gameStateService.mapData.getValue();
      const slot = gameStateService.mySlot.getValue();
      const cars = gameStateService.cars.getValue();
      if (mapLoaded && slot > -1 && cars && cars[slot]) {
        resolve();
      }
    };
    gameStateService.mapData.subscribe(check);
    gameStateService.mySlot.subscribe(check);
    gameStateService.cars.subscribe(check);
  });

  gameplayService.startRace(resumedAtStep, youAlreadySubmitted);
  document.body.classList.add('race-ready');
});
