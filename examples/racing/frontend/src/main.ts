// Entry point: wires every service by hand (constructor order matters)
// and starts the race once the chrome reports #inGame.

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

// Once per race (rematches and a reload mid-race included). A failed
// init() leaves `sceneInitialized` false so the next race retries the
// map load; the scene setup itself guards its own idempotence.
let sceneInitialized = false;
lobbyConnectionService.connectToLobby().subscribe(async ({ resumedAtStep, youAlreadySubmitted }) => {
  if (!sceneInitialized) {
    try {
      await gameplayService.init();
    } catch (err) {
      // init() already forfeited; retry on the next raceStarted.
      console.error('duel: race init failed, not starting', err);
      return;
    }
    sceneInitialized = true;
  }

  // Wait for the map and our own car; instant on a rematch.
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
