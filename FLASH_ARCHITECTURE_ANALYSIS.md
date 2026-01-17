# Flash Detection Architecture Analysis - CURRENT ISSUES

## Problem Summary
The flash detection system is completely scattered across multiple services with redundant implementations and race conditions. There are at least **4 different places** handling similar events.

## Current Architecture (BROKEN)

### 1. WebSocketManager (websocket-manager.service.ts)
```typescript
// Handles last_trade_price events
case 'last_trade_price':
    this.handleLastTradePrice(msg);

private handleLastTradePrice(msg: any): void {
    // Emits both price_update AND last_trade_price
    this.emit('price_update', priceEvent);
    this.emit('last_trade_price', { ... });
}
```

### 2. FlashDetectionEngine (flash-detection.service.ts)
```typescript
// Main detection logic with velocity, momentum, volume analysis
public async detectFlashMove(tokenId, currentPrice, currentVolume)
```

### 3. FlashMoveService (flash-move.service.ts)
```typescript
// Listens to multiple WebSocket events
this.wsManager.on('price_update', (event) => {
    this.handlePriceUpdate(event.tokenId, event.price);
});

this.wsManager.on('trade', (event) => {
    this.handleTradeEvent(event);
});

this.wsManager.on('last_trade_price', (event) => {
    this.handleLastTradePrice(event);
});

// Each calls the detection engine
await this.detectionEngine.detectFlashMove(tokenId, price);
```

### 4. ArbitrageScanner (arbitrage-scanner.ts)
```typescript
// ALSO handles last_trade_price events
case 'last_trade_price':
    this.handleLastTradePrice(msg);

private handleLastTradePrice(msg: any) {
    // Another implementation doing similar things
}
```

### 5. MarketIntelligenceService (market-intelligence.service.ts)
```typescript
// Yet another place handling flash moves
this.flashMoveService = flashMoveService;
// Emits flash_move events
```

## Issues Identified

### 1. MASSIVE REDUNDANCY
- `last_trade_price` handled in 3 different places
- Price updates processed multiple times
- Same detection logic called from multiple sources

### 2. RACE CONDITIONS
- Multiple services processing same events simultaneously
- No single source of truth for flash detection
- Events can be processed out of order

### 3. EVENT NAMING CONFUSION
- Backend emits: `flash_move`, `FLASH_MOVE_DETECTED`, `flash_move_detected`
- Frontend listens: `flash_move_detected`
- Server expects: `whale_detected` (but TradeMonitor wasn't emitting it)

### 4. MIXED RESPONSIBILITIES
- WebSocketManager doing detection logic
- ArbitrageScanner doing detection logic
- FlashMoveService doing detection logic
- No clear separation of concerns

## Proposed Clean Architecture

### Single Source of Truth Pattern
```
WebSocketManager (only handles connections)
    ↓
MarketIntelligenceService (event router/distributor)
    ↓
FlashDetectionService (single detection engine)
    ↓
FlashExecutionService (execution)
    ↓
Frontend (via Server.io)
```

### Event Flow (Clean)
```
Polymarket WebSocket
    ↓
WebSocketManager.handleMarketMessage()
    ↓
MarketIntelligenceService.routeEvent()
    ↓
FlashDetectionService.analyzeEvent()
    ↓
If flash detected → FlashExecutionService.execute()
    ↓
Server.io.emit('flash_move_detected')
    ↓
Frontend receives event
```

## Services to Refactor

### 1. ELIMINATE Redundancy
- Remove detection from ArbitrageScanner
- Remove detection from WebSocketManager
- Keep only FlashDetectionService

### 2. CREATE Event Router
- MarketIntelligenceService should route events to proper services
- No direct WebSocket listeners in individual services

### 3. UNIFY Event Names
- Standardize all event names
- Single source of truth for event definitions

### 4. SEPARATE CONCERNS
- Detection: FlashDetectionService only
- Execution: FlashExecutionService only
- Risk: FlashRiskService only
- UI: MarketIntelligenceService only

## Implementation Plan

### Phase 1: Consolidate Detection
1. Remove `handleLastTradePrice` from ArbitrageScanner
2. Remove detection logic from WebSocketManager
3. Make FlashDetectionService the single detection engine

### Phase 2: Create Event Router
1. MarketIntelligenceService receives all WebSocket events
2. Routes to appropriate services based on event type
3. Eliminates direct WebSocket dependencies

### Phase 3: Clean Event Names
1. Standardize: `flash_move_detected` (not FLASH_MOVE_DETECTED)
2. Standardize: `whale_detected` (fixed)
3. Document all event contracts

### Phase 4: Remove Race Conditions
1. Single event processing queue
2. Deduplicate at source, not in multiple places
3. Atomic event processing

## Benefits of Clean Architecture
- ✅ Single source of truth for detection
- ✅ No race conditions
- ✅ Clear separation of concerns
- ✅ Easier testing and debugging
- ✅ Better performance (no redundant processing)
- ✅ Cleaner event flow to frontend
