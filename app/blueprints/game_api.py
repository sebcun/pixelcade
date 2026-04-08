from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request
from flask_login import current_user, login_required

from app.extensions import db, protect_api_blueprint
from app.models import Game, User, XPLog

api_games_bp = Blueprint("api_games", __name__)
protect_api_blueprint(api_games_bp)

_TIER_WINDOWS = {"small": 60, "medium": 300, "large": 1800}
_TIER_AMOUNTS = {"small": 10, "medium": 35, "large": 100}


@api_games_bp.route("/<int:game_id>/xp", methods=["POST"])
@login_required
def award_game_xp(game_id: int):
    game = db.session.get(Game, game_id)
    if not game:
        return jsonify({"error": "Game not found"}), 404

    body = request.get_json(silent=True) or {}
    tier = str(body.get("tier", "")).lower().strip()
    if tier not in _TIER_AMOUNTS:
        return jsonify({"error": 'tier must be "small", "medium", or "large"'}), 400

    window_sec = _TIER_WINDOWS[tier]
    cutoff = datetime.utcnow() - timedelta(seconds=window_sec)

    q = (
        db.session.query(XPLog)
        .filter(
            XPLog.user_id == current_user.id,
            XPLog.game_id == game_id,
            XPLog.tier == tier,
            XPLog.awarded_at >= cutoff,
        )
        .order_by(XPLog.awarded_at.desc())
    )
    if q.first():
        return jsonify({"awarded": False, "reason": "rate_limited"}), 200

    amount = _TIER_AMOUNTS[tier]
    user = db.session.get(User, current_user.id)
    if not user:
        return jsonify({"error": "User not found"}), 401

    user.xp = int(user.xp or 0) + amount
    log = XPLog(
        user_id=user.id,
        game_id=game_id,
        amount=amount,
        tier=tier,
    )
    db.session.add(log)
    db.session.commit()

    return jsonify({"awarded": True, "amount": amount, "xp": user.xp}), 200
