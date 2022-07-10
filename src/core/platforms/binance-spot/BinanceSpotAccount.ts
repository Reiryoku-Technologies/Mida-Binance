/*
 * Copyright Reiryoku Technologies and its contributors, www.reiryoku.com, www.mida.org
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
*/

import {
    GenericObject,
    MidaAsset,
    MidaAssetStatement,
    MidaDate,
    MidaEmitter,
    MidaEventListener,
    MidaOrder,
    MidaOrderDirection,
    MidaOrderDirectives,
    MidaOrderPurpose,
    MidaOrderStatus,
    MidaOrderTimeInForce,
    MidaPeriod,
    MidaPosition,
    MidaQuotationPrice,
    MidaSymbol,
    MidaTick,
    MidaTickMovement,
    MidaTrade,
    MidaTradeDirection,
    MidaTradePurpose,
    MidaTradeStatus,
    MidaTradingAccount,
} from "@reiryoku/mida";
import {
    AssetBalance,
    AvgPriceResult,
    Binance,
    CandlesOptions,
    MyTrade,
    Symbol as BinanceSymbol,
} from "binance-api-node";
import { BinanceSpotAccountParameters, } from "#platforms/binance-spot/BinanceSpotAccountParameters";
import { BinanceSpotTrade, } from "#platforms/binance-spot/trades/BinanceSpotTrade";
import { BinanceSpotOrder, } from "#platforms/binance-spot/orders/BinanceSpotOrder";

const DEFAULT_RESOLVER_EVENTS: string[] = [
    "reject",
    "pending",
    "cancel",
    "expire",
    "execute",
];

export class BinanceSpotAccount extends MidaTradingAccount {
    readonly #binanceConnection: Binance;
    readonly #binanceEmitter: MidaEmitter;
    readonly #assets: Map<string, MidaAsset>;
    readonly #symbols: Map<string, MidaSymbol>;
    readonly #ticksListeners: Map<string, boolean>;
    readonly #lastTicks: Map<string, MidaTick>;

    public constructor ({
        id,
        platform,
        creationDate,
        ownerName,
        primaryAsset,
        operativity,
        positionAccounting,
        indicativeLeverage,
        binanceConnection,
    }: BinanceSpotAccountParameters) {
        super({
            id,
            platform,
            creationDate,
            ownerName,
            primaryAsset,
            operativity,
            positionAccounting,
            indicativeLeverage,
        });

        this.#binanceConnection = binanceConnection;
        this.#binanceEmitter = new MidaEmitter();
        this.#assets = new Map();
        this.#symbols = new Map();
        this.#ticksListeners = new Map();
        this.#lastTicks = new Map();
    }

    public async preload (): Promise<void> {
        await this.#preloadSymbols();
        await this.#configureListeners();
    }

    public override async placeOrder (directives: MidaOrderDirectives): Promise<MidaOrder> {
        const symbol: string = directives.symbol as string;
        const direction: MidaOrderDirection = directives.direction;
        const volume: number = directives.volume;
        const order: BinanceSpotOrder = new BinanceSpotOrder({
            id: "",
            direction,
            limitPrice: directives.limit ?? undefined,
            purpose: direction === MidaOrderDirection.BUY ? MidaOrderPurpose.OPEN : MidaOrderPurpose.CLOSE,
            requestedVolume: volume,
            status: MidaOrderStatus.REQUESTED,
            symbol,
            timeInForce: directives.timeInForce ?? MidaOrderTimeInForce.GOOD_TILL_CANCEL,
            tradingAccount: this,
            binanceConnection: this.#binanceConnection,
            binanceEmitter: this.#binanceEmitter,
            directives,
            isStopOut: false,
            trades: [],
        });

        const listeners: { [eventType: string]: MidaEventListener } = directives.listeners ?? {};
        const resolver: Promise<BinanceSpotOrder> = new Promise((resolve: (order: BinanceSpotOrder) => void) => {
            const events: string[] = directives.resolverEvents ?? DEFAULT_RESOLVER_EVENTS;

            if (events.length === 0) {
                resolve(order);
            }
            else {
                const resolverEventsUuids: Map<string, string> = new Map();

                for (const eventType of events) {
                    resolverEventsUuids.set(eventType, order.on(eventType, (): void => {
                        for (const uuid of [ ...resolverEventsUuids.values(), ]) {
                            order.removeEventListener(uuid);
                        }

                        resolve(order);
                    }));
                }
            }
        });

        for (const eventType of Object.keys(listeners)) {
            order.on(eventType, listeners[eventType]);
        }

        this.notifyListeners("order", { order, });
        order.send();

        return resolver;
    }

    public override async getBalance (): Promise<number> {
        const assetStatement: MidaAssetStatement = await this.#getAssetStatement(this.primaryAsset);

        return assetStatement.freeVolume + assetStatement.lockedVolume + assetStatement.borrowedVolume;
    }

    public override async getAssetBalance (asset: string): Promise<MidaAssetStatement> {
        return this.#getAssetStatement(asset);
    }

    public override async getBalanceSheet (): Promise<MidaAssetStatement[]> {
        const balanceSheet: MidaAssetStatement[] = [];
        const binanceAssets: AssetBalance[] = (await this.#binanceConnection.accountInfo()).balances;

        for (const binanceAsset of binanceAssets) {
            const totalVolume: number = Number(binanceAsset.free) + Number(binanceAsset.locked);

            if (totalVolume > 0) {
                balanceSheet.push({
                    tradingAccount: this,
                    date: new MidaDate(),
                    asset: binanceAsset.asset,
                    freeVolume: Number(binanceAsset.free),
                    lockedVolume: Number(binanceAsset.locked),
                    borrowedVolume: 0,
                });
            }
        }

        return balanceSheet;
    }

    public override async getEquity (): Promise<number> {
        const balanceSheet: MidaAssetStatement[] = await this.getBalanceSheet();
        const lastQuotations: GenericObject = await this.#binanceConnection.allBookTickers();
        let totalPrimaryAssetBalance: number = 0;

        for (const assetStatement of balanceSheet) {
            const asset: string = assetStatement.asset;
            const totalAssetBalance: number = assetStatement.freeVolume + assetStatement.lockedVolume;

            if (this.primaryAsset === asset) {
                totalPrimaryAssetBalance += totalAssetBalance;

                continue;
            }

            let exchangeRate: GenericObject = lastQuotations[asset + this.primaryAsset];

            if (exchangeRate) {
                totalPrimaryAssetBalance += totalAssetBalance * Number(exchangeRate.bidPrice);

                continue;
            }

            exchangeRate = lastQuotations[this.primaryAsset + asset];

            if (!exchangeRate) {
                console.log(`Exchange rate for ${asset} and the primary asset not found: excluded from equity calculation`);

                continue;
            }

            totalPrimaryAssetBalance += totalAssetBalance / Number(exchangeRate.bidPrice);
        }

        return totalPrimaryAssetBalance;
    }

    public override async getUsedMargin (): Promise<number> {
        // Binance Spot doesn't support margin trading
        return 0;
    }

    public override async getFreeMargin (): Promise<number> {
        // Binance Spot doesn't support margin trading
        return 0;
    }

    public override async getMarginLevel (): Promise<number> {
        // Binance Spot doesn't support margin trading
        return NaN;
    }

    public override async getTrades (symbol: string): Promise<MidaTrade[]> {
        const trades: MidaTrade[] = [];
        const binanceDeals: MyTrade[] = await this.#binanceConnection.myTrades({ symbol, });

        for (const binanceDeal of binanceDeals) {
            trades.push(new BinanceSpotTrade({
                orderId: binanceDeal.orderId.toString(),
                positionId: "",
                tradingAccount: this,
                symbol,
                commission: Number(binanceDeal.commission),
                commissionAsset: binanceDeal.commissionAsset.toString(),
                direction: binanceDeal.isBuyer ? MidaTradeDirection.BUY : MidaTradeDirection.SELL,
                executionDate: new MidaDate(Number(binanceDeal.time)),
                executionPrice: Number(binanceDeal.price),
                id: binanceDeal.id.toString(),
                purpose: binanceDeal.isBuyer ? MidaTradePurpose.OPEN : MidaTradePurpose.CLOSE,
                status: MidaTradeStatus.EXECUTED,
                volume: Number(binanceDeal.qty),
            }));
        }

        return trades;
    }

    #normalizeOrder (plainOrder: GenericObject): MidaOrder {
        const creationDate: MidaDate | undefined = plainOrder.time ? new MidaDate(Number(plainOrder.time)) : undefined;
        let status: MidaOrderStatus = MidaOrderStatus.REQUESTED;

        switch (plainOrder.status.toUpperCase()) {
            case "NEW": {
                if (plainOrder.type.toUpperCase() !== "MARKET") {
                    status = MidaOrderStatus.PENDING;
                }

                break;
            }
            case "PARTIALLY_FILLED":
            case "FILLED": {
                status = MidaOrderStatus.EXECUTED;

                break;
            }
            case "PENDING_CANCEL":
            case "CANCELED": {
                status = MidaOrderStatus.CANCELLED;

                break;
            }
            case "EXPIRED": {
                status = MidaOrderStatus.EXPIRED;

                break;
            }
            case "REJECTED": {
                status = MidaOrderStatus.REJECTED;

                break;
            }
        }

        return new BinanceSpotOrder({
            tradingAccount: this,
            creationDate,
            trades: [],
            direction: plainOrder.side === "BUY" ? MidaOrderDirection.BUY : MidaOrderDirection.SELL,
            id: plainOrder.orderId.toString(),
            isStopOut: false,
            lastUpdateDate: plainOrder.updateTime ? new MidaDate(Number(plainOrder.updateTime)) : creationDate,
            limitPrice: plainOrder.type === "LIMIT" ? Number(plainOrder.price) : undefined,
            purpose: plainOrder.side === "BUY" ? MidaOrderPurpose.OPEN : MidaOrderPurpose.CLOSE,
            requestedVolume: Number(plainOrder.origQty),
            status,
            symbol: plainOrder.symbol,
            timeInForce: normalizeTimeInForce(plainOrder.timeInForce),
            binanceConnection: this.#binanceConnection,
            binanceEmitter: this.#binanceEmitter,
        });
    }

    public override async getOrders (symbol: string): Promise<MidaOrder[]> {
        const binanceOrders: GenericObject[] = await this.#binanceConnection.allOrders({ symbol, });
        const executedOrders: MidaOrder[] = [];

        for (const binanceOrder of binanceOrders) {
            const order = this.#normalizeOrder(binanceOrder);

            if (order.isExecuted) {
                executedOrders.push(order);
            }
        }

        return executedOrders;
    }

    public override async getPendingOrders (): Promise<MidaOrder[]> {
        const binanceOrders: GenericObject[] = await this.#binanceConnection.openOrders({});
        const pendingOrders: MidaOrder[] = [];

        for (const binanceOrder of binanceOrders) {
            const order = this.#normalizeOrder(binanceOrder);

            if (order.status === MidaOrderStatus.PENDING) {
                pendingOrders.push(order);
            }
        }

        return pendingOrders;
    }

    public async getAssets (): Promise<string[]> {
        const assets: string[] = [];
        const binanceAssets: AssetBalance[] = (await this.#binanceConnection.accountInfo()).balances;

        for (const binanceAsset of binanceAssets) {
            assets.push(binanceAsset.asset);
        }

        return assets;
    }

    public override async getAsset (asset: string): Promise<MidaAsset | undefined> {
        const binanceAssets: AssetBalance[] = (await this.#binanceConnection.accountInfo()).balances;

        for (const binanceAsset of binanceAssets) {
            if (binanceAsset.asset === asset) {
                return new MidaAsset({ asset, tradingAccount: this, });
            }
        }

        return undefined;
    }

    async #getAssetStatement (asset: string): Promise<MidaAssetStatement> {
        const binanceAccountAssets: AssetBalance[] = (await this.#binanceConnection.accountInfo()).balances;
        const statement: MidaAssetStatement = {
            tradingAccount: this,
            date: new MidaDate(),
            asset,
            freeVolume: 0,
            lockedVolume: 0,
            borrowedVolume: 0,
        };

        for (const binanceAsset of binanceAccountAssets) {
            if (binanceAsset.asset === asset) {
                statement.freeVolume = Number(binanceAsset.free);
                statement.lockedVolume = Number(binanceAsset.locked);

                break;
            }
        }

        return statement;
    }

    async #getSymbolLastTick (symbol: string): Promise<MidaTick> {
        const lastPlainTick: GenericObject = (await this.#binanceConnection.allBookTickers())[symbol];

        return new MidaTick({
            ask: Number(lastPlainTick.askPrice),
            bid: Number(lastPlainTick.bidPrice),
            date: new MidaDate(),
            movement: MidaTickMovement.BID_ASK,
            symbol,
        });
    }

    public override async getSymbolBid (symbol: string): Promise<number> {
        const lastTick: MidaTick | undefined = this.#lastTicks.get(symbol);

        if (lastTick) {
            return lastTick.bid;
        }

        return (await this.#getSymbolLastTick(symbol)).bid;
    }

    public override async getSymbolAsk (symbol: string): Promise<number> {
        const lastTick: MidaTick | undefined = this.#lastTicks.get(symbol);

        if (lastTick) {
            return lastTick.ask;
        }

        return (await this.#getSymbolLastTick(symbol)).ask;
    }

    public override async getSymbolAveragePrice (symbol: string): Promise<number> {
        const response: AvgPriceResult = await this.#binanceConnection.avgPrice({ symbol, }) as AvgPriceResult;

        return Number(response.price);
    }

    public override async getSymbolPeriods (symbol: string, timeframe: number): Promise<MidaPeriod[]> {
        const periods: MidaPeriod[] = [];
        const binancePeriods: GenericObject[] = await this.#binanceConnection.candles(<CandlesOptions> {
            symbol,
            interval: normalizeTimeframeForBinance(timeframe),
        });

        for (const binancePeriod of binancePeriods) {
            periods.push(new MidaPeriod({
                symbol,
                close: Number(binancePeriod.close),
                high: Number(binancePeriod.high),
                low: Number(binancePeriod.low),
                open: Number(binancePeriod.open),
                quotationPrice: MidaQuotationPrice.BID,
                startDate: new MidaDate(Number(binancePeriod.openTime)),
                timeframe,
                volume: Number(binancePeriod.volume),
            }));
        }

        return periods;
    }

    public override async getSymbols (): Promise<string[]> {
        return [ ...this.#symbols.keys(), ];
    }

    public override async getSymbol (symbol: string): Promise<MidaSymbol | undefined> {
        return this.#symbols.get(symbol);
    }

    public override async watchSymbolTicks (symbol: string): Promise<void> {
        if (this.#ticksListeners.has(symbol)) {
            return;
        }

        this.#binanceConnection.ws.ticker(symbol, (plainTick: GenericObject) => this.#onTick(plainTick));

        this.#ticksListeners.set(symbol, true);
    }

    public override async getOpenPositions (): Promise<MidaPosition[]> {
        return [];
    }

    public override async isSymbolMarketOpen (symbol: string): Promise<boolean> {
        return true;
    }

    public override async getCryptoAssetDepositAddress (asset: string, net: string): Promise<string> {
        return (await this.#binanceConnection.depositAddress({ coin: asset, network: net, })).address;
    }

    async #onTick (plainTick: GenericObject): Promise<void> {
        const symbol: string = plainTick.symbol;
        const tick: MidaTick = new MidaTick({
            ask: Number(plainTick.bestAsk),
            bid: Number(plainTick.bestBid),
            date: new MidaDate(),
            movement: MidaTickMovement.BID_ASK,
            symbol,
        });

        this.#lastTicks.set(symbol, tick);

        if (this.#ticksListeners.has(symbol)) {
            this.notifyListeners("tick", { tick, });
        }
    }

    async #preloadSymbols (): Promise<void> {
        const binanceSymbols: BinanceSymbol[] = (await this.#binanceConnection.exchangeInfo()).symbols;

        this.#symbols.clear();

        for (const binanceSymbol of binanceSymbols) {
            const volumeFilter: GenericObject | undefined = getPlainSymbolFilterByType(binanceSymbol, "LOT_SIZE");

            this.#symbols.set(binanceSymbol.symbol, new MidaSymbol({
                baseAsset: binanceSymbol.baseAsset,
                tradingAccount: this,
                description: "",
                leverage: 0,
                lotUnits: 1,
                maxLots: volumeFilter?.maxQty ?? -1,
                minLots: volumeFilter?.minQty ?? -1,
                quoteAsset: binanceSymbol.quoteAsset,
                symbol: binanceSymbol.symbol,
            }));
        }
    }

    #onNewOrder (descriptor: GenericObject): void {

    }

    async #configureListeners (): Promise<void> {
        await this.#binanceConnection.ws.user((update: GenericObject): void => {
            if (update.eventType === "executionReport" && update.orderId && update.orderStatus.toUpperCase() === "NEW") {
                this.#onNewOrder(update);
            }

            this.#binanceEmitter.notifyListeners("update", { update, });
        });
    }
}

export function getPlainSymbolFilterByType (plainSymbol: BinanceSymbol, type: string): GenericObject | undefined {
    for (const filter of plainSymbol.filters) {
        if (filter.filterType === type) {
            return filter;
        }
    }

    return undefined;
}

export function normalizeTimeframeForBinance (timeframe: number): string {
    switch (timeframe) {
        case 60: {
            return "1m";
        }
        case 180: {
            return "3m";
        }
        case 300: {
            return "5m";
        }
        case 900: {
            return "15m";
        }
        case 1800: {
            return "30m";
        }
        case 3600: {
            return "1h";
        }
        case 7200: {
            return "2h";
        }
        case 14400: {
            return "4h";
        }
        case 21600: {
            return "6h";
        }
        case 43200: {
            return "12h";
        }
        case 86400: {
            return "1d";
        }
        case 604800: {
            return "1w";
        }
        case 2592000: {
            return "1M";
        }
        default: {
            throw new Error("Binance Spot doesn't support this timeframe");
        }
    }
}

export function normalizeTimeInForceForBinance (timeInForce: MidaOrderTimeInForce): string {
    switch (timeInForce) {
        case MidaOrderTimeInForce.GOOD_TILL_CANCEL: {
            return "GTC";
        }
        case MidaOrderTimeInForce.FILL_OR_KILL: {
            return "FOK";
        }
        case MidaOrderTimeInForce.IMMEDIATE_OR_CANCEL: {
            return "IOC";
        }
        default: {
            throw new Error("Binance Spot doesn't support this time in force");
        }
    }
}

export function normalizeTimeInForce (timeInForce: string): MidaOrderTimeInForce {
    switch (timeInForce.toUpperCase()) {
        case "GTC": {
            return MidaOrderTimeInForce.GOOD_TILL_CANCEL;
        }
        case "FOK": {
            return MidaOrderTimeInForce.FILL_OR_KILL;
        }
        case "IOC": {
            return MidaOrderTimeInForce.IMMEDIATE_OR_CANCEL;
        }
        default: {
            throw new Error(`Unknown order time in force ${timeInForce}`);
        }
    }
}
