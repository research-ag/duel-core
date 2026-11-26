// "Build a bot": a canister player for a game already listed here, built
// by an AI builder from botPrompt.ts's prompt. Three ways, picked at the
// end of "How it works": caffeine.ai (an app of its own, put live first,
// then tried on the real game and registered from its page),
// through hosty.live (a Claude Code cloud session first, or an agent on
// the computer) or everything the developer's own (icp-cli, their key and
// cycles). The last two test it against a local copy of the game made
// from the module the backend runs, then put it online and have it
// register itself with the game (a bot is never listed on this
// dashboard). Opened from a game's info dialog it starts filled in for
// that game; from the header it starts by picking one.

import { useState } from "react";

import { botPrompt } from "../botPrompt";
import {
  CAFFEINE_COST,
  CAFFEINE_GO_LIVE,
  claudeCodeLink,
  ENV_NAME,
} from "../cloudSession";
import type { Way } from "../cloudSession";
import type { AggregatorActor, GameView, Target } from "../types";
import { gameUrl } from "../types";
import {
  CaffeineSetup,
  DeploySessionNote,
  HostyCycles,
  HostySetup,
  IcpIdentitySteps,
  OpenNote,
  OwnSetup,
} from "./CloudSessionSetup";
import { CodeBlock } from "./CodeBlock";
import { GamePicker } from "./GamePicker";
import { Wizard } from "./Wizard";
import { WayPicker } from "./WayPicker";

const STEPS = [
  "Pick a game",
  "How it works",
  "Set up",
  "Copy the prompt",
  "Build and test",
  "Go live",
] as const;

export function BotTutorialWizard({
  initial,
  games,
  loading,
  actor,
  onClose,
}: {
  initial: Target | undefined;
  games: GameView[];
  loading: boolean;
  actor: AggregatorActor | undefined;
  onClose: () => void;
}) {
  const [target, setTarget] = useState(initial);
  const [way, setWay] = useState<Way>();
  return (
    <Wizard
      kicker="Build a bot"
      title={
        target
          ? `A bot for “${target.game.title}”.`
          : "A bot for a listed game."
      }
      steps={STEPS}
      initialStep={initial ? 1 : 0}
      reachable={!target ? 0 : !way ? 1 : STEPS.length - 1}
      onClose={onClose}
      finish={{ label: "Done", onClick: onClose }}
      render={(step, next) => (
        <>
          {step === 0 && (
            <>
              <p>
                Which game should your bot play? Only games that take bots as
                players can be picked.
              </p>
              <GamePicker
                games={games}
                loading={loading}
                actor={actor}
                purpose="bot"
                picked={target}
                onPick={(t) => {
                  setTarget(t);
                  next();
                }}
              />
            </>
          )}
          {target && step === 1 && (
            <HowItWorksStep
              way={way}
              onPick={(w) => {
                setWay(w);
                next();
              }}
            />
          )}
          {target && way && step === 2 && <SetupStep way={way} />}
          {target && way && step === 3 && (
            <PromptStep target={target} way={way} />
          )}
          {target && way && step === 4 && <BuildStep way={way} />}
          {target && way && step === 5 && (
            <GoLiveStep target={target} way={way} />
          )}
        </>
      )}
    />
  );
}

function HowItWorksStep({
  way,
  onPick,
}: {
  way: Way | undefined;
  onPick: (way: Way) => void;
}) {
  return (
    <>
      <p>
        A bot is a small program of your own that lives on the Internet Computer
        next to the game and plays it. Whenever it is the bot's turn, the game
        asks it for a move and plays whatever it answers. Players pick it from
        the game's list of bots, and it is rated on the leaderboard like anyone
        else. The game itself stays untouched.
      </p>
      <p>
        You don't write it yourself. An AI does, from a prompt we give you plus
        your own description of how the bot should play. Through hosty.live or
        your own tools, it tests the bot against a private copy of the game
        before anything goes online; in caffeine.ai it goes live first, and you
        try it on the real game before anyone can pick it. Pick your way:
      </p>
      <WayPicker
        picked={way}
        onPick={onPick}
        options={[
          {
            way: "caffeine",
            title: "caffeine.ai",
            note: `A website where you describe an app in a chat. Its AI builds the bot as an app of its own; once it is live, you try it against the real game before you list it. ${CAFFEINE_COST}`,
          },
          {
            way: "hosty",
            title: "Through hosty.live",
            note: "Nothing to install: an AI tool writes the code, and hosty.live takes care of the whole deployment. The bot goes live for a few dollars, paid by card.",
          },
          {
            way: "own",
            title: "All your own, with icp-cli",
            note: "An AI tool on your computer, your own key and cycles. For people who already work with icp-cli.",
          },
        ]}
      />
    </>
  );
}

function SetupStep({ way }: { way: Way }) {
  if (way === "hosty") return <HostySetup />;
  if (way === "own") return <OwnSetup />;
  return <CaffeineSetup what="the bot is an app of its own, apart from the game" />;
}

function PromptStep({ target, way }: { target: Target; way: Way }) {
  const prompt = botPrompt(target, way);
  return (
    <>
      <p>
        This prompt is filled in for <strong>{target.game.title}</strong>.{" "}
        {way === "caffeine"
          ? "Start a new app on caffeine.ai and paste it into its chat:"
          : "Paste it into the session (on your computer: into your coding tool):"}
      </p>
      <CodeBlock
        code={prompt}
        wrap
        open={way === "hosty" ? claudeCodeLink(prompt, ENV_NAME) : undefined}
      />
      <p>Finish it with your own description after its last line:</p>
      <CodeBlock
        code={
          'Name: Pencil Pusher\nTwo levels: "Casual" plays a random legal move; "Sharp" takes any\nwin, blocks any threat, and otherwise plays the strongest move it finds.'
        }
      />
      <p className="hint">
        You don't need to understand the prompt. It points the AI at the game's
        rules and at the framework's playbook for exactly this task: how to
        test, and what not to touch.
        {way === "caffeine"
          ? " If it asks questions first, answer them or say “just build it”."
          : " The AI installs the tools it needs, or tells you how."}
      </p>
      {way === "hosty" && <OpenNote />}
    </>
  );
}

function BuildStep({ way }: { way: Way }) {
  if (way === "caffeine")
    return (
      <>
        <p>
          Caffeine's AI reads the game's rules, published by the game itself,
          and builds the bot with a page of its own. Its preview shows that
          page: the bot's canister id, a try-out form that seats the bot at a
          table of yours, and the buttons that list it with the game.
        </p>
        <p>
          The preview's bot is a temporary draft, so it does not play the real
          game: its games would stay on the game's leaderboard after the draft
          is gone. Caffeine's own check cannot sign in either, so its last note
          may say testing could not confirm a step. You try the bot once it is
          live, before anyone can pick it (next step). Nothing is spent up to
          here beyond the credits the AI's work uses.
        </p>
      </>
    );
  return (
    <>
      <p>The AI works through it on its own:</p>
      <ol className="tutorial-list">
        <li>
          It reads the game's rules, published by the game itself, and downloads
          the game's program, checking it is exactly the one running live.
        </li>
        <li>It writes the bot and tests its move choices one by one.</li>
        <li>
          It starts a private copy of the game, in the session or on your
          computer, and plays whole games against your bot there, at every
          level, until every game ends cleanly.
        </li>
      </ol>
      <p>
        Ask for changes until it plays the way you want: stronger, weaker, a new
        level. Nothing on the real game changes, and nothing costs anything up
        to here.
        {way === "hosty" &&
          " To watch it yourself before paying, ask for a free online try-out: a temporary copy of the game on hosty.live's cloud engine with your bot beside it (an empty copy, not the real game), or your bot in a free 24-hour canister playing the real game."}
      </p>
      <p className="hint">
        Some games' programs are not published in hosty.live's module store
        (never one built in caffeine.ai, and any other whose developer has not
        put it there). For those there is no private copy: the AI tests the
        bot's move choices alone and tells you so, and you try the bot on the
        real game once its canister is bought, before it joins the game's list
        of bots (next step).
      </p>
    </>
  );
}

function GoLiveStep({ target, way }: { target: Target; way: Way }) {
  const { game, backend } = target;
  const unregister = `icp canister call bot unregister '(principal "${backend}")' -e ic`;
  return (
    <>
      {way === "caffeine" ? (
        <>
          <ol className="tutorial-list">
            <li>
              Click <strong>Go live</strong> in caffeine.ai ({CAFFEINE_GO_LIVE}).
            </li>
            <li>
              Open the live bot's page, sign in with Internet Identity and give
              the AI the principal it shows. It writes that into the bot, which
              takes Register and Unregister from you alone, and you go live
              again (no credits this time). Until then the bot refuses every
              Register, so nobody else can claim it.
            </li>
            <li>
              Try it: on the game's own page, open a table with “Invite a
              friend” and copy its invite link, then paste it into the bot's
              try-out form. The bot sits down at that table, which only the two
              of you can see. Play a few games at every level and leave the
              table when you are done. Each change is another Go live.
            </li>
            <li>
              Press <strong>Register</strong>: the bot joins the game's list of
              bots under its name.
            </li>
          </ol>
          <p className="hint">
            caffeine.ai picks the canister's subnet. If it is not the game's,
            each of the bot's moves takes a few seconds.
          </p>
        </>
      ) : way === "hosty" ? (
        <>
          <p>
            Before paying anything, ask the session which subnet the game is on.
            A bot must sit on its game's subnet, and hosty.live creates every
            canister on one subnet. If the game is elsewhere, the bot goes
            online from your computer with icp-cli, your own key and cycles
            instead: the session gives you those steps, and you skip the top-up
            below.
          </p>
          <HostyCycles cost="A bot's canister costs 1.5 TC (a few dollars)." />
          <p>Then tell the session</p>
          <CodeBlock code="Put my bot live on mainnet through hosty.live (buy its canister) and register it as <bot name>." />
          <p>
            with the name players should see. It asks you to approve a deploy
            session, buys the bot's canister from your balance, installs the
            bot, and adds it to the game's list of bots in that same session. It
            checks the game lists it and gives you the bot's canister id (also
            in its <code>README.md</code>). Ask for changes any time later: each
            one is tested again and upgrades the same canister, so the bot keeps
            its place in the list.
          </p>
          <p className="hint">
            For a game whose program is not published, the session buys and
            installs the bot first, seats it at a table you open with “Invite a
            friend” for you to play against, and adds it to the list only once
            you are happy with it.
          </p>
          <DeploySessionNote />
        </>
      ) : (
        <ol className="tutorial-list">
          <IcpIdentitySteps cycles="about 2–3T (a few dollars) is comfortable for a bot" />
          <li>
            Publish the bot and add it to the game's list of bots, in the
            project folder (the AI left these in its <code>README.md</code>{" "}
            too). First find the game's subnet: the bot goes on the same one, so
            its moves stay quick.
            <CodeBlock
              code={`curl -sf https://ic-api.internetcomputer.org/api/v3/canisters/${backend} | grep -o '"subnet_id":"[^"]*"' | cut -d'"' -f4`}
            />
            If it prints nothing, stop here and ask the AI. Otherwise put the
            subnet id it printed in place of{" "}
            <code>&lt;the game's subnet&gt;</code> below, and the name players
            should see in place of <code>&lt;bot name&gt;</code>. For a game
            whose program is not published, leave out{" "}
            <code>icp canister link backend</code>, and run{" "}
            <code>icp canister call bot register</code> only after you have
            played the bot on the game: open a table with “Invite a friend” and
            ask the AI to seat the bot there.
            <CodeBlock
              code={`icp canister link backend ${backend} -e ic --force\nicp deploy bot -e ic --subnet <the game's subnet>\nicp canister call bot register '(principal "${backend}", "<bot name>")' -e ic`}
            />
            Later upgrades run <code>icp deploy bot -e ic</code> again, without{" "}
            <code>--subnet</code>. If the project folder lost its record of the
            bot (<code>.icp/data/mappings/ic.ids.json</code> has no{" "}
            <code>bot</code> entry), link the bot's canister id first:
            <CodeBlock code="icp canister link bot <bot id> -e ic" />
          </li>
        </ol>
      )}
      <p>
        That's it: open{" "}
        <a href={gameUrl(game)} target="_blank" rel="noreferrer">
          {game.title}
        </a>{" "}
        and challenge your bot from its list of bots. Registering again renames
        it; unregistering takes it off the list
        {way === "hosty"
          ? " (ask your AI)."
          : way === "caffeine"
            ? " (Unregister on the bot's page)."
            : ":"}
      </p>
      {way === "own" && <CodeBlock code={unregister} />}
    </>
  );
}
