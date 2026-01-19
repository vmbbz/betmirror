export interface UserWhalePreferences {
    userId: string;
    whaleWallets: string[];
    enabled: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface WhaleFilterEvent {
    userId: string;
    whaleWallets: string[];
    action: 'added' | 'removed' | 'updated';
}

export interface FilteredWhaleSignal {
    originalSignal: any;
    userId: string;
    isMatch: boolean;
}
