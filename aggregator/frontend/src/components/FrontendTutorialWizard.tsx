// "Make own frontend": a player's route to their own client for a game
// already listed here. The work is done by an AI coding agent on the
// player's machine from the prompt in step 2; `game` is the card the
// wizard was opened from, or undefined when opened from the header.

import type { GameView } from "../types";
import { frontendPrompt } from "../frontendPrompt";
import { CodeBlock } from "./CodeBlock";
import { Wizard } from "./Wizard";

const STEPS = [
  "Prerequisites",
  "Copy the prompt",
  "Describe and build",
  "Deploy to mainnet",
  "Register",
] as const;

export function FrontendTutorialWizard({
  game,
  isLoggedIn,
  onClose,
  onRegister,
}: {
  game: GameView | undefined;
  isLoggedIn: boolean;
  onClose: () => void;
  onRegister: () => void;
}) {
  return (
    <Wizard
      kicker="Make own frontend"
      title={
        game
          ? `Your own look for “${game.title}”.`
          : "Your own look for any listed game."
      }
      steps={STEPS}
      onClose={onClose}
      finish={{
        label: "Register your frontend",
        onClick: onRegister,
        disabled: !isLoggedIn,
      }}
      render={(step) => (
        <>
          {step === 0 && <PrerequisitesStep />}
          {step === 1 && <PromptStep game={game} />}
          {step === 2 && <BuildStep />}
          {step === 3 && <DeployStep />}
          {step === 4 && <RegisterStep isLoggedIn={isLoggedIn} />}
        </>
      )}
    />
  );
}

function PrerequisitesStep() {
  return (
    <>
      <p>
        Every game here is two canisters: a backend that holds the rules and
        the tables, and a frontend that draws them. You can put a frontend of
        your own in front of any game's backend. It plays at the same tables
        as the original, so your players and theirs meet each other. No
        Motoko, and no access to the game's source, is needed.
      </p>
      <ol className="tutorial-list">
        <li>
          An AI coding agent that can run terminal commands in a project
          directory, such as Claude Code. It does the building.
        </li>
        <li>
          <code>icp-cli</code> (see the{" "}
          <a
            href="https://github.com/dfinity/icp-cli"
            target="_blank"
            rel="noreferrer"
          >
            icp-cli project
          </a>
          ) and Node.js 21 or newer:
          <CodeBlock code={"icp --version\nnode --version"} />
        </li>
        <li>
          Cycles for one canister, the frontend. About 1–2T is comfortable:
          <CodeBlock code="icp cycles balance -e ic" />
          Short? Get your principal with <code>icp identity principal</code>{" "}
          and top it up with ICP (<code>icp cycles mint --icp 1 -e ic</code>)
          or by card at{" "}
          <a href="https://cycle.express/" target="_blank" rel="noreferrer">
            cycle.express
          </a>
          .
        </li>
      </ol>
    </>
  );
}

function PromptStep({ game }: { game: GameView | undefined }) {
  return (
    <>
      {game ? (
        <p>
          This prompt is filled in for <strong>{game.title}</strong>. Copy it
          as it is.
        </p>
      ) : (
        <p>
          Replace the title and the address in the first lines with the game
          you picked, or open this guide from a game's own{" "}
          <strong>Make own frontend</strong> button to have them filled in.
        </p>
      )}
      <CodeBlock code={frontendPrompt(game)} wrap />
      <p className="hint">
        It tells the agent how to learn the game from its backend canister
        alone: the rules and move types as plain text over HTTP, the
        interface from the canister's metadata, and the backend's own wasm
        for a private local copy to test against.
      </p>
    </>
  );
}

function BuildStep() {
  return (
    <>
      <p>
        Make an empty directory, start your agent in it, paste the prompt, and
        finish it with your own description after the last line. Say what you
        want to see, in your own words:
      </p>
      <CodeBlock
        code={
          "Here is the frontend I want:\nA hand-drawn notebook look: the board sketched in pencil on squared\npaper, my marks in blue ink and the opponent's in red, a small doodle\nwhen somebody wins. Big touch targets, it has to work on a phone."
        }
      />
      <CodeBlock code={"mkdir my-frontend && cd my-frontend"} />
      <p>
        The agent pulls the game's backend, runs a copy of it on a local
        network on your machine, builds the frontend against that copy and
        plays a full game on it before it reports back. Nothing touches the
        live game during this.
      </p>
      <p className="hint">
        Open the local address it gives you and play both seats in two tabs
        yourself. Ask for changes until it is what you had in mind.
      </p>
    </>
  );
}

function DeployStep() {
  return (
    <>
      <p>
        The agent leaves these commands in the project's{" "}
        <code>README.md</code>, with the game's backend id filled in. Run them
        from the project directory; the second one spends cycles:
      </p>
      <CodeBlock
        code={
          "icp canister link backend <game-backend-canister-id> -e ic\nicp deploy frontend -e ic"
        }
      />
      <p>
        The first line points your frontend at the live game instead of the
        local copy. Deploy <code>frontend</code> by name, as written: the
        backend is not yours to deploy.
      </p>
      <p>Then note your new frontend's canister id for the last step:</p>
      <CodeBlock code="icp canister status frontend -e ic -i" />
    </>
  );
}

function RegisterStep({ isLoggedIn }: { isLoggedIn: boolean }) {
  return (
    <>
      <p>
        Last step: list your frontend here as an entry of its own, next to the
        original. You'll need the frontend canister id from the previous step,
        a title that tells the two apart, a short description, and a banner
        image.
      </p>
      {isLoggedIn ? (
        <p>
          Click "Register your frontend" below to open the registration form.
        </p>
      ) : (
        <p className="error">
          Log in with Internet Identity first (top right), then come back here
          to register.
        </p>
      )}
    </>
  );
}
