use bevy::math::primitives::Sphere;
use bevy::prelude::*;
use bevy_mcp_bridge::BevyMcpPlugin;

#[derive(Component, Reflect, Default)]
#[reflect(Component)]
struct FixtureMarker;

#[derive(Resource, Reflect, Default)]
#[reflect(Resource)]
struct FixtureState {
    elapsed: f32,
}

fn observe_virtual_time(time: Res<Time<Virtual>>, mut state: ResMut<FixtureState>) {
    state.elapsed = time.elapsed_secs();
}

fn main() {
    let mut app = App::new();
    app.add_plugins(DefaultPlugins);
    app.add_plugins(BevyMcpPlugin);

    app.register_type::<FixtureMarker>();
    app.register_type::<FixtureState>();
    app.init_resource::<FixtureState>();
    app.add_systems(Update, observe_virtual_time);

    let sphere = app
        .world_mut()
        .resource_mut::<Assets<Mesh>>()
        .add(Sphere::new(0.5));
    let material = app
        .world_mut()
        .resource_mut::<Assets<StandardMaterial>>()
        .add(StandardMaterial::from_color(Color::srgb(0.8, 0.3, 0.2)));

    app.world_mut().spawn((
        Camera3d::default(),
        Transform::from_xyz(0.0, 0.0, 5.0).looking_at(Vec3::ZERO, Vec3::Y),
    ));
    app.world_mut().spawn((
        DirectionalLight::default(),
        Transform::from_rotation(Quat::from_euler(EulerRot::XYZ, -0.5, 0.3, 0.0)),
    ));
    app.world_mut().spawn((
        FixtureMarker,
        Mesh3d(sphere),
        MeshMaterial3d(material),
        Transform::default(),
    ));
    app.world_mut()
        .spawn((FixtureMarker, Transform::from_xyz(2.0, 0.0, 0.0)));

    app.run();
}
