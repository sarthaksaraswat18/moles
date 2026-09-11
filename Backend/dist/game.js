"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRoundHitChance = getRoundHitChance;
exports.getMultiplier = getMultiplier;
exports.createRevealHoles = createRevealHoles;
exports.getMaxRounds = getMaxRounds;
exports.getHoleCount = getHoleCount;
exports.getMultiplierTable = getMultiplierTable;
exports.getRoundChanceTable = getRoundChanceTable;
exports.getBetSizeChanceTables = getBetSizeChanceTables;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const CONFIG_PATH = path_1.default.resolve(__dirname, '..', 'config', 'game-config.json');
const DEFAULT_GAME_CONFIG = {
    holeCount: 7,
    maxRounds: 6,
    multiplierTable: {
        1: [10.22, 48.02, 336.14, 2352.98, 16470.86, 115296.02],
        2: [3.43, 12, 42.01, 147.06, 514.71, 1801.5],
        3: [2.28, 5.33, 12.45, 29.04, 67.78, 158.15],
        4: [1.71, 3, 5.25, 9.19, 16.08, 28.14],
        5: [1.27, 1.54, 1.96, 2.18, 3.96, 7.37],
        6: [1.03, 1.14, 1.27, 1.81, 2.11, 2.47],
    },
    roundChanceTable: {
        1: [0.0000001, 0.000000001, 0.0000000001, 0.000000000001, 0.00000000001, 0.0000000000000001],
        2: [0.32, 0.25, 0.17, 0.1, 0.001, 0.00001],
        3: [0.35, 0.20, 0.1, 0.001, 0.00008, 0.0001],
        4: [0.57, 0.32, 0.20, 0.12, 0.05, 0.0001],
        5: [0.8, 0.7, 0.57, 0.42, 0.3, 0.0001],
        6: [0.92, 0.82, 0.67, 0.45, 0.3, 0.25],
    },
};
let cachedConfig = null;
let cachedConfigMtimeMs = -1;
let lastConfigError = null;
function cloneTable(table) {
    return Object.fromEntries(Object.entries(table).map(([moleCount, values]) => [Number(moleCount), [...values]]));
}
function cloneBetSizeChanceTables(tables) {
    if (!tables) {
        return undefined;
    }
    return Object.fromEntries(Object.entries(tables).map(([betSize, table]) => [Number(betSize), cloneTable(table)]));
}
function cloneConfig(config) {
    return {
        holeCount: config.holeCount,
        maxRounds: config.maxRounds,
        multiplierTable: cloneTable(config.multiplierTable),
        roundChanceTable: cloneTable(config.roundChanceTable),
        betSizeChanceTables: cloneBetSizeChanceTables(config.betSizeChanceTables),
    };
}
function logConfigError(message) {
    if (message !== lastConfigError) {
        console.warn(message);
        lastConfigError = message;
    }
}
function parsePositiveInteger(value, field) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new Error(`${field} must be a positive integer.`);
    }
    return value;
}
function parseTable(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${field} must be an object keyed by mole count.`);
    }
    return Object.fromEntries(Object.entries(value).map(([moleCount, entries]) => {
        const numericMoleCount = Number(moleCount);
        if (!Number.isInteger(numericMoleCount) || numericMoleCount <= 0) {
            throw new Error(`${field} contains an invalid mole count: ${moleCount}.`);
        }
        if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))) {
            throw new Error(`${field}[${moleCount}] must be an array of numbers.`);
        }
        return [numericMoleCount, [...entries]];
    }));
}
function parseBetSizeChanceTables(value, field) {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${field} must be an object keyed by bet size.`);
    }
    return Object.fromEntries(Object.entries(value).map(([betSize, table]) => {
        const numericBetSize = Number(betSize);
        if (!Number.isFinite(numericBetSize) || numericBetSize <= 0) {
            throw new Error(`${field} contains an invalid bet size: ${betSize}.`);
        }
        return [numericBetSize, parseTable(table, `${field}[${betSize}]`)];
    }));
}
function parseConfig(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Game config must be a JSON object.');
    }
    const rec = raw;
    return {
        holeCount: parsePositiveInteger(rec.holeCount, 'holeCount'),
        maxRounds: parsePositiveInteger(rec.maxRounds, 'maxRounds'),
        multiplierTable: parseTable(rec.multiplierTable, 'multiplierTable'),
        roundChanceTable: parseTable(rec.roundChanceTable, 'roundChanceTable'),
        betSizeChanceTables: parseBetSizeChanceTables(rec.betSizeChanceTables, 'betSizeChanceTables'),
    };
}
function getGameConfig() {
    try {
        const stats = fs_1.default.statSync(CONFIG_PATH);
        if (cachedConfig && stats.mtimeMs === cachedConfigMtimeMs) {
            return cachedConfig;
        }
        const parsed = JSON.parse(fs_1.default.readFileSync(CONFIG_PATH, 'utf8'));
        cachedConfig = parseConfig(parsed);
        cachedConfigMtimeMs = stats.mtimeMs;
        lastConfigError = null;
        return cachedConfig;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown config error.';
        if (cachedConfig) {
            logConfigError(`Using last valid game config because ${CONFIG_PATH} could not be reloaded: ${message}`);
            return cachedConfig;
        }
        const fallbackConfig = cloneConfig(DEFAULT_GAME_CONFIG);
        cachedConfig = fallbackConfig;
        cachedConfigMtimeMs = -1;
        logConfigError(`Using built-in game config because ${CONFIG_PATH} could not be loaded: ${message}`);
        return fallbackConfig;
    }
}
function randomHole(holeCount, excluding) {
    const candidates = Array.from({ length: holeCount }, (_, index) => index).filter((index) => index !== excluding);
    const pool = candidates.length > 0 ? candidates : [0];
    return pool[Math.floor(Math.random() * pool.length)];
}
function randomUniqueHoles(holeCount, count, options) {
    const result = new Set();
    if (typeof options?.include === 'number') {
        result.add(options.include);
    }
    while (result.size < count) {
        const nextHole = randomHole(holeCount, options?.exclude);
        if (nextHole !== options?.exclude) {
            result.add(nextHole);
        }
    }
    return Array.from(result);
}
function getChanceTableForBetAmount(config, betAmount) {
    const tables = config.betSizeChanceTables;
    if (!tables || Object.keys(tables).length === 0) {
        return config.roundChanceTable;
    }
    const betSizes = Object.keys(tables).map(Number).sort((left, right) => left - right);
    const exact = tables[betAmount];
    if (exact) {
        return exact;
    }
    let bestBetSize = betSizes[0];
    let bestDelta = Math.abs(bestBetSize - betAmount);
    for (const tier of betSizes.slice(1)) {
        const delta = Math.abs(tier - betAmount);
        if (delta < bestDelta) {
            bestBetSize = tier;
            bestDelta = delta;
        }
    }
    return tables[bestBetSize] ?? config.roundChanceTable;
}
const MAX_PLAYER_PROFIT_SATS = 500;
const HOUSE_RTP_TARGET = 0.7;
function getRoundHitChance(moleCount, round, betAmount) {
    const config = getGameConfig();
    const chanceTable = typeof betAmount === 'number' && Number.isFinite(betAmount)
        ? getChanceTableForBetAmount(config, betAmount)
        : config.roundChanceTable;
    const roundChances = chanceTable[moleCount];
    if (!roundChances) {
        throw new Error(`Unsupported mole count: ${moleCount}`);
    }
    const hitChance = roundChances[round - 1];
    if (typeof hitChance !== 'number') {
        throw new Error(`Unsupported round ${round} for mole count ${moleCount}`);
    }
    let effectiveChance = hitChance;
    if (typeof betAmount === 'number' && Number.isFinite(betAmount)) {
        const multiplier = config.multiplierTable[moleCount]?.[round - 1];
        if (typeof multiplier !== 'number') {
            throw new Error(`Unsupported round ${round} for mole count ${moleCount}`);
        }
        const potentialPayout = Math.floor(betAmount * multiplier);
        const potentialProfit = potentialPayout - betAmount;
        if (potentialProfit > MAX_PLAYER_PROFIT_SATS) {
            effectiveChance *= MAX_PLAYER_PROFIT_SATS / potentialProfit;
        }
    }
    effectiveChance *= HOUSE_RTP_TARGET;
    return Math.min(Math.max(effectiveChance, 0), 1);
}
function getMultiplier(moleCount, hitCount) {
    if (hitCount === 0) {
        return 0;
    }
    const multiplier = getGameConfig().multiplierTable[moleCount]?.[hitCount - 1];
    if (typeof multiplier !== 'number') {
        throw new Error(`Unsupported hit count ${hitCount} for mole count ${moleCount}`);
    }
    return multiplier;
}
function createRevealHoles(moleCount, selectedHole, hit) {
    const holeCount = getGameConfig().holeCount;
    return hit
        ? randomUniqueHoles(holeCount, moleCount, { include: selectedHole })
        : randomUniqueHoles(holeCount, moleCount, { exclude: selectedHole });
}
function getMaxRounds() {
    return getGameConfig().maxRounds;
}
function getHoleCount() {
    return getGameConfig().holeCount;
}
function getMultiplierTable() {
    return cloneTable(getGameConfig().multiplierTable);
}
function getRoundChanceTable() {
    return cloneTable(getGameConfig().roundChanceTable);
}
function getBetSizeChanceTables() {
    const config = getGameConfig();
    return cloneBetSizeChanceTables(config.betSizeChanceTables) ?? {
        100: cloneTable(config.roundChanceTable),
    };
}
