// The scripted session every fixture is generated from. Fixed, not random:
// tests assert against these exact boundaries, and a fixture that drifted
// between runs would make every downstream failure ambiguous.
//
// No real names anywhere — players, characters and NPCs are invented, and the
// audio is tones and noise.

export const SAMPLE_RATE = 8000;
export const DEFAULT_SECONDS = 60;

export const PLAYERS = [
  { id: "pl_ash", display: "Ash", discord: "ashcodes", roll20: "Ash B.", isDm: false, track: 1 },
  { id: "pl_bly", display: "Bly", discord: "blybird", roll20: "Bly", isDm: false, track: 2 },
  { id: "pl_cyd", display: "Cyd", discord: "cyd_h", roll20: "Cyd H.", isDm: false, track: 3 },
  { id: "pl_dm", display: "Wren", discord: "wren_dm", roll20: "Wren", isDm: true, track: 4 },
];

export const CHARACTERS = [
  { id: "ch_seren", playerId: "pl_ash", name: "Seren Thaldane", aliases: ["Seren"] },
  { id: "ch_borik", playerId: "pl_bly", name: "Borik Stonefall", aliases: ["Borik"] },
  { id: "ch_wisp", playerId: "pl_cyd", name: "Wisp", aliases: [] },
];

export const NPCS = [
  { id: "npc_innkeep", name: "Halda the Innkeeper", aliases: ["Halda"] },
  { id: "npc_captain", name: "Bandit Captain", aliases: ["the captain"] },
];

export const GLOSSARY = ["Thornwatch", "the Ford", "Greymoor", "sunsteel", "Ashen Pact"];

/**
 * One entry per utterance. `mode` is the ground truth persona label; `roll`
 * points at the roll id the utterance announces, when it announces one.
 * Times are seconds from the recording start and never overlap within a track.
 */
export const UTTERANCES = [
  {
    id: "u0001",
    player: "pl_dm",
    start: 1.0,
    end: 5.2,
    mode: "narration",
    character: null,
    text: "The road to the Ford narrows here, and the Thornwatch banners have not been mended in years.",
  },
  {
    id: "u0002",
    player: "pl_ash",
    start: 6.0,
    end: 9.0,
    mode: "in_character",
    character: "ch_seren",
    text: "I do not like this. We should cross before the light goes.",
  },
  {
    id: "u0003",
    player: "pl_bly",
    start: 9.5,
    end: 12.0,
    mode: "out_of_character",
    character: null,
    text: "Can I make a perception check on the treeline?",
  },
  {
    id: "u0004",
    player: "pl_dm",
    start: 12.4,
    end: 14.0,
    mode: "out_of_character",
    character: null,
    text: "Go ahead, that's a perception check.",
  },
  {
    id: "u0005",
    player: "pl_bly",
    start: 14.5,
    end: 16.2,
    mode: "out_of_character",
    character: null,
    text: "That is a seventeen.",
    roll: "r0001",
  },
  {
    id: "u0006",
    player: "pl_dm",
    start: 17.0,
    end: 21.5,
    mode: "narration",
    character: null,
    text: "You catch a glint of sunsteel in the brush. Someone is waiting.",
  },
  {
    id: "u0007",
    player: "pl_dm",
    start: 22.0,
    end: 25.0,
    mode: "in_character",
    character: "npc_captain",
    text: "Far enough, travellers. Leave the cart and you keep your teeth.",
  },
  {
    id: "u0008",
    player: "pl_cyd",
    start: 25.5,
    end: 28.0,
    mode: "in_character",
    character: "ch_wisp",
    text: "Borik, the one on the left is favouring a leg.",
  },
  {
    id: "u0009",
    player: "pl_dm",
    start: 28.5,
    end: 30.0,
    mode: "out_of_character",
    character: null,
    text: "Everyone roll initiative.",
  },
  {
    id: "u0010",
    player: "pl_ash",
    start: 30.4,
    end: 31.8,
    mode: "out_of_character",
    character: null,
    text: "Initiative, I got nineteen.",
    roll: "r0002",
  },
  {
    id: "u0011",
    player: "pl_bly",
    start: 32.0,
    end: 33.4,
    mode: "out_of_character",
    character: null,
    text: "Eleven for me.",
    roll: "r0003",
  },
  {
    id: "u0012",
    player: "pl_cyd",
    start: 33.6,
    end: 35.0,
    mode: "out_of_character",
    character: null,
    text: "I rolled a six.",
    roll: "r0004",
  },
  {
    id: "u0013",
    player: "pl_ash",
    start: 36.0,
    end: 39.5,
    mode: "in_character",
    character: "ch_seren",
    text: "Then we finish it quickly. Seren draws her blade and steps into the gap.",
  },
  {
    id: "u0014",
    player: "pl_ash",
    start: 40.0,
    end: 41.6,
    mode: "out_of_character",
    character: null,
    text: "Attack on the captain, that's a twenty-three.",
    roll: "r0005",
  },
  {
    id: "u0015",
    player: "pl_dm",
    start: 42.0,
    end: 44.0,
    mode: "out_of_character",
    character: null,
    text: "That hits. Roll your damage.",
  },
  {
    id: "u0016",
    player: "pl_ash",
    start: 44.4,
    end: 45.8,
    mode: "out_of_character",
    character: null,
    text: "Nine damage.",
    roll: "r0006",
  },
  {
    id: "u0017",
    player: "pl_dm",
    start: 46.2,
    end: 49.5,
    mode: "narration",
    character: null,
    text: "The blade catches him across the shoulder and he staggers back into the brush.",
  },
  {
    id: "u0018",
    player: "pl_bly",
    start: 50.0,
    end: 52.4,
    mode: "in_character",
    character: "ch_borik",
    text: "Stay behind me, Wisp. This is what I am for.",
  },
  {
    id: "u0019",
    player: "pl_cyd",
    start: 52.8,
    end: 54.2,
    mode: "out_of_character",
    character: null,
    text: "Wait, is he still standing?",
  },
  {
    id: "u0020",
    player: "pl_dm",
    start: 54.6,
    end: 57.0,
    mode: "in_character",
    character: "npc_captain",
    text: "Hold! Hold. We are done here.",
  },
];

/** Rolls as they appear in the Roll20 log, in order. */
export const ROLLS = [
  {
    id: "r0001",
    who: "Bly",
    player: "pl_bly",
    kind: "check",
    formula: "1d20+5",
    dice: [12],
    mod: 5,
    total: 17,
    skill: "Perception",
  },
  {
    id: "r0002",
    who: "Ash B.",
    player: "pl_ash",
    kind: "initiative",
    formula: "1d20+3",
    dice: [16],
    mod: 3,
    total: 19,
  },
  {
    id: "r0003",
    who: "Bly",
    player: "pl_bly",
    kind: "initiative",
    formula: "1d20+1",
    dice: [10],
    mod: 1,
    total: 11,
  },
  {
    id: "r0004",
    who: "Cyd H.",
    player: "pl_cyd",
    kind: "initiative",
    formula: "1d20+2",
    dice: [4],
    mod: 2,
    total: 6,
  },
  {
    id: "r0005",
    who: "Ash B.",
    player: "pl_ash",
    kind: "attack",
    formula: "1d20+7",
    dice: [16],
    mod: 7,
    total: 23,
    target: "Bandit Captain",
  },
  {
    id: "r0006",
    who: "Ash B.",
    player: "pl_ash",
    kind: "damage",
    formula: "1d8+5",
    dice: [4],
    mod: 5,
    total: 9,
  },
];

/** Turn-order transitions: combat opens after initiative and closes at the end. */
export const TURN_ORDER = [
  {
    at: 35.5,
    marker: "combat_started",
    entries: [
      { name: "Seren Thaldane", value: 19 },
      { name: "Bandit Captain", value: 14 },
      { name: "Borik Stonefall", value: 11 },
      { name: "Wisp", value: 6 },
    ],
  },
  { at: 57.5, marker: "combat_ended", entries: [] },
];
