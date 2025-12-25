import crypto from 'crypto';
import { Schema } from 'mongoose';

/**
 * Service providing Field-Level Encryption (FLE) for MongoDB.
 * Uses AES-256-GCM for authenticated encryption.
 */
export class DatabaseEncryptionService {
  private static masterKey: Buffer | null = null;
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_LENGTH = 12;
  private static readonly TAG_LENGTH = 16;
  private static readonly SALT = 'bet-mirror-db-salt-2025';

  /**
   * Initializes the encryption service by deriving the master key once.
   * This prevents expensive PBKDF2/Scrypt operations on every database access.
   */
  static init(envKey: string) {
    if (!envKey) {
      console.error("❌ DatabaseEncryptionService: MONGO_ENCRYPTION_KEY is missing from environment!");
      return;
    }
    
    try {
      // Derive a 32-byte key using Scrypt (secure and better performance for initialization)
      this.masterKey = crypto.scryptSync(envKey, this.SALT, 32);
      console.log("🔐 Database Encryption Service Initialized (AES-256-GCM)");
    } catch (error) {
      console.error("❌ DatabaseEncryptionService: Failed to derive master key", error);
    }
  }

  /**
   * Encrypts a string using AES-256-GCM.
   * Returns a format: iv:authTag:encryptedData
   */
  static encrypt(text: string): string {
    if (!this.masterKey) {
      throw new Error("DatabaseEncryptionService: Not initialized. Call init() first.");
    }
    
    const iv = crypto.randomBytes(this.IV_LENGTH);
    const cipher = crypto.createCipheriv(this.ALGORITHM, this.masterKey, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  /**
   * Decrypts an AES-256-GCM encrypted string.
   */
  static decrypt(encryptedData: string): string {
    if (!this.masterKey) {
      throw new Error("DatabaseEncryptionService: Not initialized. Call init() first.");
    }
    
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      // Data is not in the expected encrypted format, return as is
      return encryptedData;
    }

    try {
      const iv = Buffer.from(parts[0], 'hex');
      const authTag = Buffer.from(parts[1], 'hex');
      const encryptedText = parts[2];

      const decipher = crypto.createDecipheriv(this.ALGORITHM, this.masterKey, iv);
      decipher.setAuthTag(authTag);
      
      let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      
      return decrypted;
    } catch (error) {
      console.error("❌ Decryption failed. Possible key mismatch or data corruption.");
      throw error;
    }
  }

  /**
   * Attaches encryption middleware to a Mongoose schema for a specific field.
   * Handles both 'save' (pre) and 'init' (post-fetch) hooks.
   */
  static createEncryptionMiddleware(schema: Schema, fieldPath: string) {
    // Helper to get nested values (e.g., 'credentials.apiKey')
    const getNestedValue = (obj: any, path: string) => {
        return path.split('.').reduce((prev, curr) => prev && prev[curr], obj);
    };

    // Helper to set nested values
    const setNestedValue = (obj: any, path: string, value: any) => {
        const parts = path.split('.');
        const last = parts.pop();
        const target = parts.reduce((prev, curr) => prev && prev[curr], obj);
        if (target && last) target[last] = value;
    };

    // Hook for when a document is being saved to the database
    // Fix: Removing the 'next' parameter and using a synchronous signature to prevent TypeScript from incorrectly
    // inferring the first parameter as 'SaveOptions', which caused "This expression is not callable" error.
    schema.pre('save', function(this: any) {
        const value = getNestedValue(this, fieldPath);
        // Only encrypt if it's a string and doesn't look already encrypted
        if (value && typeof value === 'string' && !value.includes(':')) {
            setNestedValue(this, fieldPath, DatabaseEncryptionService.encrypt(value));
        }
    });

    // Hook for when a document is initialized from database data
    schema.post('init', function(doc) {
        const value = getNestedValue(doc, fieldPath);
        if (value && typeof value === 'string' && value.includes(':')) {
            try {
                setNestedValue(doc, fieldPath, DatabaseEncryptionService.decrypt(value));
            } catch (e) {
                // If decryption fails, we leave the encrypted string (or handle as needed)
                console.error(`Failed to decrypt field ${fieldPath} for document ${doc._id}`);
            }
        }
    });
  }

  static validateEncryptionKey(): boolean {
    return !!this.masterKey;
  }
}