pub mod methods;

use bevy_app::{App, Plugin};
use bevy_brp_extras::{AgentTool, AppAgentToolExt, BrpExtrasPlugin};
use bevy_remote::{RemoteMethodSystemId, RemoteMethods};

pub struct BevyMcpPlugin;

impl Plugin for BevyMcpPlugin {
    fn build(&self, app: &mut App) {
        app.add_plugins(BrpExtrasPlugin);

        let world_stats_id = app.world_mut().register_system(methods::world_stats);
        let time_control_id = app.world_mut().register_system(methods::time_control);
        {
            let mut remote_methods = app.world_mut().resource_mut::<RemoteMethods>();
            remote_methods.insert(
                "bevy_mcp/world_stats",
                RemoteMethodSystemId::Instant(world_stats_id),
            );
            remote_methods.insert(
                "bevy_mcp/time_control",
                RemoteMethodSystemId::Instant(time_control_id),
            );
        }

        app.register_agent_tool(
            AgentTool::new(
                "bevy_mcp_world_stats",
                "bevy_mcp/world_stats",
                "Return bounded aggregate ECS world statistics",
            )
            .params_schema_for::<methods::WorldStatsParams>()
            .result_schema_for::<methods::WorldStatsResult>(),
        );

        app.register_agent_tool(
            AgentTool::new(
                "bevy_mcp_time_control",
                "bevy_mcp/time_control",
                "Pause, resume, or set the relative speed of virtual time",
            )
            .params_schema_for::<methods::TimeControlParams>()
            .result_schema_for::<methods::TimeControlResult>(),
        );
    }
}
