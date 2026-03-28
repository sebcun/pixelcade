from flask import Blueprint

games_bp = Blueprint("games", __name__)


@games_bp.route("/")
def index():
    return "games list placeholder"


@games_bp.route("/<game_id>")
def game(game_id: str):
    return "games detail placeholder"
