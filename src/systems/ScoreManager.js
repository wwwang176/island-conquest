/**
 * Tracks team scores based on captured flags.
 * Each owned flag gives +1 point every 3 seconds.
 * First team to 500 wins.
 */
export class ScoreManager {
    constructor(eventBus) {
        this.eventBus = eventBus;
        this.scores = { teamA: 0, teamB: 0 };
        this.winScore = 500;
        this.scoreInterval = 3;     // seconds between scoring ticks
        this.scoreTimer = 0;
        this.gameOver = false;
        this.winner = null;
    }

    update(flags, dt) {
        if (this.gameOver) return;

        this.scoreTimer += dt;
        if (this.scoreTimer >= this.scoreInterval) {
            this.scoreTimer -= this.scoreInterval;

            // Count owned flags and add points
            let aFlags = 0, bFlags = 0;
            for (const flag of flags) {
                if (flag.owner === 'teamA') aFlags++;
                else if (flag.owner === 'teamB') bFlags++;
            }

            this.scores.teamA += aFlags;
            this.scores.teamB += bFlags;

            // Check win condition
            if (this.scores.teamA >= this.winScore) {
                this.gameOver = true;
                this.winner = 'teamA';
                this.eventBus.emit('gameOver', { winner: 'teamA', scores: { ...this.scores } });
            } else if (this.scores.teamB >= this.winScore) {
                this.gameOver = true;
                this.winner = 'teamB';
                this.eventBus.emit('gameOver', { winner: 'teamB', scores: { ...this.scores } });
            }
        }
    }
}
