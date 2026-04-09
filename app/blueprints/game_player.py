from flask import Blueprint, render_template

game_player_bp = Blueprint("game_player", __name__)


@game_player_bp.route("/<int:game_id>")
def play_game(game_id: int):
    return render_template("game_play.html", game_id=game_id)
