export interface FlashMove {
    tokenId: string;
    conditionId: string;
    oldPrice: number;
    newPrice: number;
    velocity: number;
    timestamp: number;
    question?: string;
    image?: string;
    marketSlug?: string;
}

export interface ActiveSnipe {
    tokenId: string;
    entryPrice: number;
    currentPrice: number;
    shares: number;
    timestamp: number;
    targetPrice: number;
    question?: string;
}