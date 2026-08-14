-- Add locked_balance to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_balance DECIMAL(12, 2) DEFAULT 0.00;

-- Immutable Wallet Ledger
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id),
    type VARCHAR(50) NOT NULL,
    amount DECIMAL(12, 2) NOT NULL,
    balance_before DECIMAL(12, 2) NOT NULL,
    balance_after DECIMAL(12, 2) NOT NULL,
    reference_type VARCHAR(50),
    reference_id UUID,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wallet_user_id ON wallet_transactions(user_id);

-- Room lock system
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS state VARCHAR(20) DEFAULT 'WAITING';
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS number_sequence JSONB DEFAULT '[]'::JSONB;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS current_call_index INT DEFAULT 0;

-- Winning history
CREATE TABLE IF NOT EXISTS game_winners (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    room_id UUID NOT NULL REFERENCES rooms(id),
    user_id UUID NOT NULL REFERENCES users(id),
    card_id INT NOT NULL,
    pattern VARCHAR(50),
    prize DECIMAL(12, 2) NOT NULL,
    verified_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_game_winners_room ON game_winners(room_id);
